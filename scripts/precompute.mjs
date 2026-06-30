// =============================================================================
// 事前変換: 年度×科目×種類を変換し、段落データを静的JSONとして書き出す。
//   司法試験:   web/converted/<年度>/<科目>.json
//   予備試験:   web/converted/yobi/<年度>/<科目>.json
//     （年度キー・科目名が司法と衝突するため yobi/ 配下に分ける）
//
// ブラウザ（convert.js / yobi-convert.js）はこのJSONがあれば取得して整形する
// だけで、PDF取得・PDF.js 解析を丸ごと省略できる。無ければ従来のクライアント
// 変換にフォールバックする。中身は { 種類: { paras, pdfUrl } }。
//
// ブラウザと同じ解析結果になるよう、PDF.js は同一バージョン（pdfjs-dist
// 4.0.379）を setPdfjs() で注入して同じパイプラインを再利用する。
//
// 使い方:
//   npm install                       # pdfjs-dist を入れる
//   node scripts/precompute.mjs       # 司法・予備とも全年度
//   node scripts/precompute.mjs r6 r7 # 指定年度のみ（司法・予備とも）
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs } from "../parser.js";

setPdfjs(pdfjs); // ブラウザの CDN ロードの代わりに pdfjs-dist を注入

const { buildEntry } = await import("../convert.js");
const { buildYobiEntry } = await import("../yobi-convert.js");
const { SUBJECT_MAP } = await import("../data.js");
const { YEAR_URL_MAP, RESULTS_URL_MAP } = await import("../years.js");
const { YOBI_YEAR_URL_MAP } = await import("../yobi-years.js");
const { YOBI_RONBUN_SUBJECTS } = await import("../yobi-moj.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "converted");

const argYears = process.argv.slice(2);
const silent = { log: () => {}, setProgress: () => {} };

// 1年度×1科目を変換して JSON エントリ（{ 種類: {paras, pdfUrl} }）を作る。
// build は ({yearKey, subject, docType}, ctx)→entry を返す関数。
async function buildSubject(build, yearKey, subject, types) {
  const out = {};
  let ok = 0;
  let skip = 0;
  for (const docType of types) {
    try {
      const entry = await build({ yearKey, subject, docType }, silent);
      out[docType] = { paras: entry.paras, pdfUrl: entry.pdfUrl };
      ok++;
      console.log(`OK  ${yearKey} ${subject} ${docType} (${entry.paras.length}段落)`);
    } catch (e) {
      skip++;
      console.log(`--  ${yearKey} ${subject} ${docType}: ${e.message}`);
    }
  }
  return { out, ok, skip };
}

let ok = 0;
let skip = 0;

// ── 司法試験 ──────────────────────────────────────────────────────────────
console.log("\n##### 司法試験 #####");
const shihouYears = argYears.length ? argYears : Object.keys(YEAR_URL_MAP);
for (const yearKey of shihouYears) {
  if (!(yearKey in YEAR_URL_MAP)) {
    console.log(`?? 未知の年度をスキップ: ${yearKey}`);
    continue;
  }
  // 結果ページ未登録の年度は趣旨・採点実感を持たない
  const types =
    yearKey in RESULTS_URL_MAP
      ? ["試験問題", "出題の趣旨", "採点実感"]
      : ["試験問題"];
  for (const subject of Object.keys(SUBJECT_MAP)) {
    const r = await buildSubject(buildEntry, yearKey, subject, types);
    ok += r.ok;
    skip += r.skip;
    if (Object.keys(r.out).length) {
      const dir = join(OUT, yearKey);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${subject}.json`), JSON.stringify(r.out));
    }
  }
}

// ── 予備試験（論文式）────────────────────────────────────────────────────
console.log("\n##### 司法試験予備試験（論文式）#####");
const yobiYears = argYears.length ? argYears : Object.keys(YOBI_YEAR_URL_MAP);
const yobiTypes = ["試験問題", "出題の趣旨"]; // 予備に採点実感は無い
for (const yearKey of yobiYears) {
  if (!(yearKey in YOBI_YEAR_URL_MAP)) {
    console.log(`?? 予備: 未知の年度をスキップ: ${yearKey}`);
    continue;
  }
  for (const subject of YOBI_RONBUN_SUBJECTS) {
    const r = await buildSubject(buildYobiEntry, yearKey, subject, yobiTypes);
    ok += r.ok;
    skip += r.skip;
    if (Object.keys(r.out).length) {
      const dir = join(OUT, "yobi", yearKey);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${subject}.json`), JSON.stringify(r.out));
    }
  }
}

console.log(`\n完了: ${ok}件 生成 / ${skip}件 スキップ`);
