import { chromium } from "playwright";
import fs from "node:fs";

type Status = "open" | "closed" | "unknown";

const FORM_URL = process.env.FORM_URL!;
const NTFY_TOPIC = process.env.NTFY_TOPIC!;
const STATE_FILE = "state.json";

// 停止中ページの文言。実際の停止中ページを見て調整してください
const CLOSED_PATTERNS = [
  /is now full/i,
  /\bfull\b/i,
  /技術的な詳細|Technical details/i,
  /回答を受け付けていません/,
  /not (currently )?accepting responses/i,
];

async function checkStatus(): Promise<Status> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "ja-JP" });
    await page.goto(FORM_URL, { waitUntil: "networkidle", timeout: 60_000 });

    // 受付中の目印：質問の入力欄、またはページ送り・送信ボタン
    const inputs = page.locator(
      'input:not([type="hidden"]), textarea, [role="radio"], [role="checkbox"], [role="listbox"], [role="combobox"]'
    );
    const navButton = page.getByRole("button", { name: /次へ|送信|Next|Submit/i });
    const openSignal = inputs.or(navButton);

    // 停止中の目印
    const closedSignal = page.getByText(/full|技術的な詳細|Technical details|受け付けていません|not accepting/i);

    // 一定時間待つ代わりに、どちらかの目印が表示されるまで待つ（最大20秒）
    await openSignal.or(closedSignal).first().waitFor({ timeout: 20_000 }).catch(() => {});

    // 受付中の判定を先に行う（説明文に "full" が含まれていても誤判定しないため）
    if ((await openSignal.count()) > 0) return "open";

    const text = await page.locator("body").innerText();
    if (CLOSED_PATTERNS.some((p) => p.test(text))) return "closed";

    // --- 調査用：判定できなかったときに中身を出力 ---
    console.log("url:", page.url());
    console.log("title:", await page.title());
    console.log("text:", text.slice(0, 500).replace(/\s+/g, " "));
    console.log("buttons:", await page.getByRole("button").allInnerTexts());
    await page.screenshot({ path: "debug.png", fullPage: true });
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