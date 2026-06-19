// =============================================================================
// 事前変換: 年度×科目×種類を変換し、段落データを静的JSONとして
// web/converted/<年度>/<科目>.json に書き出す。
//
// ブラウザ（convert.js の convertText）はこのJSONがあれば取得して整形するだけで、
// PDF取得・PDF.js 解析を丸ごと省略できる。無ければ従来のクライアント変換に
// フォールバックする。中身は { 種類: { paras, pdfUrl } }。
//
// ブラウザと同じ解析結果になるよう、PDF.js は同一バージョン（pdfjs-dist
// 4.0.379）を setPdfjs() で注入して同じパイプライン（parser.js/convert.js）を
// 再利用する。
//
// 使い方:
//   npm install                      # pdfjs-dist を入れる
//   node scripts/precompute.mjs      # YEAR_URL_MAP の全年度
//   node scripts/precompute.mjs r6 r7  # 指定年度のみ
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs } from "../parser.js";

setPdfjs(pdfjs); // ブラウザの CDN ロードの代わりに pdfjs-dist を注入

const { buildEntry } = await import("../convert.js");
const { SUBJECT_MAP } = await import("../data.js");
const { YEAR_URL_MAP, RESULTS_URL_MAP } = await import("../years.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "converted");

const argYears = process.argv.slice(2);
const yearKeys = argYears.length ? argYears : Object.keys(YEAR_URL_MAP);
const subjects = Object.keys(SUBJECT_MAP);
const types = ["試験問題", "出題の趣旨", "採点実感"];
const silent = { log: () => {}, setProgress: () => {} };

let ok = 0;
let skip = 0;
for (const yearKey of yearKeys) {
  if (!(yearKey in YEAR_URL_MAP)) {
    console.log(`?? 未知の年度をスキップ: ${yearKey}`);
    continue;
  }
  for (const subject of subjects) {
    const out = {};
    for (const docType of types) {
      // 結果ページが未登録の年度は趣旨・採点実感を持たない
      if (docType !== "試験問題" && !(yearKey in RESULTS_URL_MAP)) continue;
      try {
        const entry = await buildEntry({ yearKey, subject, docType }, silent);
        out[docType] = { paras: entry.paras, pdfUrl: entry.pdfUrl };
        ok++;
        console.log(
          `OK  ${yearKey} ${subject} ${docType} (${entry.paras.length}段落)`,
        );
      } catch (e) {
        skip++;
        console.log(`--  ${yearKey} ${subject} ${docType}: ${e.message}`);
      }
    }
    if (Object.keys(out).length) {
      const dir = join(OUT, yearKey);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${subject}.json`), JSON.stringify(out));
    }
  }
}
console.log(`\n完了: ${ok}件 生成 / ${skip}件 スキップ`);
