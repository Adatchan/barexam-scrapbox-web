// =============================================================================
// 各HTMLの版番号（キャッシュ対策）とインラインスクリプトのCSPハッシュを更新する
//
// GitHub Pages は配信物を一定時間キャッシュさせ、端末によってはそれより長く
// 古いファイルが残る。入口（app.js / tantou.js）と CSS だけに版番号を付けても、
// そこから import される部品（ui.js・search.js など）が古いまま残ると、新しい
// 入口が求める export が無く読み込みに失敗する。そこで次の3つを行う。
//
//   1. ルート直下の *.js（ブラウザ配信のモジュール全部）と style.css の内容
//      ハッシュを求める（変わったファイルだけ URL が変わり、他はキャッシュが効く）
//   2. 各HTMLのインポートマップ（<script type="importmap">）に
//      "./ui.js": "./ui.js?v=<ハッシュ>" の対応を書き、入口の script src と
//      style.css の ?v= もハッシュにする
//   3. インラインスクリプト（インポートマップ・エラー表示）の SHA-256 を計算し、
//      CSP（meta）の script-src の 'sha256-…' を書き換える
//
// .githooks/pre-commit から自動実行される（手動実行も可）。
//
// 使い方: node scripts/bump-version.mjs          # 書き換える
//         node scripts/bump-version.mjs --check  # 最新か確かめる（古ければ終了コード1）
// =============================================================================
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["index.html", "tantou.html"];
const check = process.argv.includes("--check");

const hashOf = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 10);

// ブラウザに配信するモジュール（ルート直下の .js。scripts/ や worker/ は対象外）
const modules = readdirSync(ROOT)
  .filter((f) => /^[A-Za-z0-9_-]+\.js$/.test(f))
  .sort();
const version = {};
for (const f of [...modules, "style.css"])
  version[f] = hashOf(readFileSync(join(ROOT, f)));

const importMap = JSON.stringify({
  imports: Object.fromEntries(
    modules.map((f) => [`./${f}`, `./${f}?v=${version[f]}`]),
  ),
});

// CSP の照合対象はインラインスクリプトの中身そのもの。HTML コメント内の
// <script> を拾わないよう、コメントを除いてから探す。
function inlineScriptHashes(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const hashes = [];
  for (const m of body.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(m[1] || "")) continue;
    hashes.push(
      `'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`,
    );
  }
  return hashes;
}

let changed = 0;
for (const page of PAGES) {
  const file = join(ROOT, page);
  const html = readFileSync(file, "utf8");
  let next = html;

  // 1) インポートマップ
  if (!/<script type="importmap">[\s\S]*?<\/script>/.test(next)) {
    console.log(`${page}: <script type="importmap"> がありません`);
    process.exit(1);
  }
  next = next.replace(
    /<script type="importmap">[\s\S]*?<\/script>/,
    `<script type="importmap">${importMap}</script>`,
  );

  // 2) 入口モジュール・CSS の ?v=
  for (const f of [...modules, "style.css"]) {
    const re = new RegExp(`(\\./${f.replace(".", "\\.")}\\?v=)[^"]+`, "g");
    next = next.replace(re, `$1${version[f]}`);
  }

  // 3) CSP のインラインスクリプトのハッシュ（script-src の 'sha256-…' を総入れ替え）
  const hashes = inlineScriptHashes(next).join(" ");
  next = next.replace(/(script-src[^;"]*?)((?:\s*'sha256-[^']+')+)/, `$1 ${hashes}`);

  if (next !== html) {
    changed++;
    if (!check) writeFileSync(file, next);
    console.log(`${check ? "古い" : "更新"}: ${page}`);
  }
}

if (check && changed) {
  console.log("版番号・CSPハッシュが古いです。node scripts/bump-version.mjs を実行してください。");
  process.exit(1);
}
console.log(
  changed
    ? `版番号・CSPハッシュを更新しました（${changed}ファイル）`
    : "版番号・CSPハッシュは最新です",
);
