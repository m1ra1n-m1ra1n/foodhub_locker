import { chromium } from "playwright";
import fs from "node:fs";

type Status = "open" | "closed" | "unknown";

const FORM_URL = process.env.FORM_URL!;
const NTFY_TOPIC = process.env.NTFY_TOPIC!;
const STATE_FILE = "state.json";

// 停止中ページの文言。実際の停止中ページを見て調整してください
const CLOSED_PATTERNS = [
  /回答を受け付けていません/,
  /not (currently )?accepting responses/i,
];

async function checkStatus(): Promise<Status> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "ja-JP" });
    await page.goto(FORM_URL, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(3000); // 描画完了を待つ

    const text = await page.locator("body").innerText();
    if (CLOSED_PATTERNS.some((p) => p.test(text))) return "closed";

    // 送信ボタンがあれば受付中と判定
    const submit = page.getByRole("button", { name: /送信|Submit/i });
    if ((await submit.count()) > 0) return "open";

    return "unknown";
  } finally {
    await browser.close();
  }
}

async function notify(title: string, message: string) {
  await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message,
      click: FORM_URL, // 通知タップでフォームを開く
      priority: 5,
      tags: ["bell"],
    }),
  });
}

const prev: Status = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).status;
const now = await checkStatus();
console.log(`prev=${prev} now=${now}`);

if (prev === "closed" && now === "open") {
  await notify("Forms 受付再開", "フォームの回答受付が開始されました");
}

// unknown のときは状態を上書きしない（一時的なエラーによる誤通知を防ぐ）
if (now !== "unknown" && now !== prev) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ status: now }) + "\n");
}