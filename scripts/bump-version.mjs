// =============================================================================
// index.html のキャッシュバスター（?v=）を現在日時で更新する
//
// GitHub Pages は最大10分キャッシュされるため、app.js / style.css の更新を
// 確実に配信するにはバージョンクエリの更新が必要。手動更新は漏れやすいので
// .githooks/pre-commit から自動実行される（手動実行も可）。
//
// 使い方: node scripts/bump-version.mjs
// =============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "index.html");

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const v = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;

const html = readFileSync(INDEX, "utf8");
const next = html
  .replace(/(app\.js\?v=)[^"]+/, `$1${v}`)
  .replace(/(style\.css\?v=)[^"]+/, `$1${v}`);

if (next !== html) {
  writeFileSync(INDEX, next);
  console.log(`キャッシュバスターを更新: v=${v}`);
} else {
  console.log("バージョンクエリが見つかりませんでした（index.html を確認してください）");
  process.exit(1);
}
