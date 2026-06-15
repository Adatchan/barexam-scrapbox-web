// =============================================================================
// 各HTMLのキャッシュバスター（?v=）を現在日時で更新する
//
// GitHub Pages は最大10分キャッシュされるため、JSモジュール / CSS の更新を
// 確実に配信するにはバージョンクエリの更新が必要。手動更新は漏れやすいので
// .githooks/pre-commit から自動実行される（手動実行も可）。
//
// 使い方: node scripts/bump-version.mjs
// =============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// HTML ファイルごとに、?v= を更新する対象アセットのファイル名
const PAGES = {
  "index.html": ["app.js", "style.css"],
  "tantou.html": ["tantou.js", "style.css"],
};

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const v = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;

let updated = 0;
for (const [page, assets] of Object.entries(PAGES)) {
  const file = join(ROOT, page);
  const html = readFileSync(file, "utf8");
  let next = html;
  for (const asset of assets) {
    const re = new RegExp(`(${asset.replace(".", "\\.")}\\?v=)[^"]+`, "g");
    next = next.replace(re, `$1${v}`);
  }
  if (next !== html) {
    writeFileSync(file, next);
    updated++;
  }
}

if (updated > 0) {
  console.log(`キャッシュバスターを更新: v=${v}（${updated}ファイル）`);
} else {
  console.log("バージョンクエリが見つかりませんでした（HTML を確認してください）");
  process.exit(1);
}
