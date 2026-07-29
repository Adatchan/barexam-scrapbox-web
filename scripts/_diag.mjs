// 一時: 合冊PDFのテキスト片を覗いて、科目の扉行がどう抽出されるか調べる。
//
// この実行環境からは法務省へ直接アクセスできないため、GitHub Actions 上で
// 動かしてログを読む。
//
// 使い方: node scripts/_diag.mjs <PDFのURL> <探す語>...
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs, setPdfDocOptions, extractBoxes } from "../parser.js";

setPdfjs(pdfjs);
const pdfjsDir = createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")
  .replace(/package\.json$/, "");
setPdfDocOptions({
  cMapUrl: `${pdfjsDir}cmaps/`,
  standardFontDataUrl: `${pdfjsDir}standard_fonts/`,
});

const [url, ...words] = process.argv.slice(2);
if (!url) throw new Error("PDFのURLを指定してください。");

const res = await fetch(url);
if (!res.ok) throw new Error(`取得失敗: ${res.status}`);
const bytes = new Uint8Array(await res.arrayBuffer());
console.log(`取得: ${url} (${bytes.byteLength} bytes)`);

const boxes = await extractBoxes(bytes);
console.log(`テキスト片: ${boxes.length}`);

const nosp = (s) => s.replace(/[\s　]+/g, "");
for (const w of words) {
  const key = nosp(w);
  console.log(`\n── 「${w}」を含む片 ──`);
  let n = 0;
  boxes.forEach((b, i) => {
    if (!nosp(b.text).includes(key)) return;
    n++;
    if (n > 12) return;
    console.log(
      `[${i}] p${b.page} len=${b.text.length} x0=${Math.round(b.x0)} ${JSON.stringify(b.text.slice(0, 100))}`,
    );
  });
  console.log(`  該当 ${n} 件`);
}

// 各片の先頭 30 文字を通し番号つきで（構造の把握用）
if (process.env.DUMP_ALL) {
  console.log("\n── 全片 ──");
  boxes.forEach((b, i) =>
    console.log(`[${i}] p${b.page} ${JSON.stringify(b.text.slice(0, 40))}`),
  );
}
