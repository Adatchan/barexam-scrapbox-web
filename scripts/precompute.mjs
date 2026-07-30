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
// 既に converted/ にあるものは作り直さない。過去問のPDFは差し替わらないので
// 取り直す意味がなく（法務省への負荷も無駄）、手作業で直した箇所を上書きして
// しまわないためでもある。解析ルールを直して全部を作り直すときは --force。
//
// 使い方:
//   npm install                       # pdfjs-dist を入れる
//   node scripts/precompute.mjs       # 未取得の分だけ（週次巡回はこれ）
//   node scripts/precompute.mjs r6 r7 # 指定年度のみ（司法・予備とも）
//   node scripts/precompute.mjs --force       # 全件を作り直す
//   node scripts/precompute.mjs --force r6    # 指定年度を作り直す
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs, setPdfDocOptions } from "../parser.js";

setPdfjs(pdfjs); // ブラウザの CDN ロードの代わりに pdfjs-dist を注入

// CMap・標準フォントはブラウザでは CDN から取るが、Node では node_modules の
// 同じ資産を使う（無いと一部PDFからテキストを抽出できない）
const pdfjsDir = createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")
  .replace(/package\.json$/, "");
setPdfDocOptions({
  cMapUrl: `${pdfjsDir}cmaps/`,
  standardFontDataUrl: `${pdfjsDir}standard_fonts/`,
});

const { buildEntry } = await import("../convert.js");
const { buildYobiEntry } = await import("../yobi-convert.js");
const { SUBJECT_MAP } = await import("../data.js");
const { YEAR_URL_MAP, RESULTS_URL_MAP } = await import("../years.js");
const { YOBI_YEAR_URL_MAP } = await import("../yobi-years.js");
const { YOBI_RONBUN_SUBJECTS } = await import("../yobi-moj.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "converted");

const args = process.argv.slice(2);
const force = args.includes("--force");
const argYears = args.filter((a) => !a.startsWith("--"));
const silent = { log: () => {}, setProgress: () => {} };

// 既存の JSON（無ければ空）。--force のときは無いものとして扱う
function readExisting(file) {
  if (force) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {}; // 未生成
  }
}

// 1年度×1科目を変換して JSON エントリ（{ 種類: {paras, pdfUrl} }）を作る。
// build は ({yearKey, subject, docType}, ctx)→entry を返す関数。
async function buildSubject(build, yearKey, subject, types, existing = {}) {
  const out = {};
  let ok = 0;
  let skip = 0;
  let kept = 0;
  for (const docType of types) {
    // 既にあるものはそのまま残す（PDF取得も解析も行わない）
    if (existing[docType]?.paras?.length) {
      out[docType] = existing[docType];
      kept++;
      continue;
    }
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
  return { out, ok, skip, kept };
}

let ok = 0;
let skip = 0;
let kept = 0;

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
    const dir = join(OUT, yearKey);
    const file = join(dir, `${subject}.json`);
    const r = await buildSubject(
      buildEntry,
      yearKey,
      subject,
      types,
      readExisting(file),
    );
    ok += r.ok;
    skip += r.skip;
    kept += r.kept;
    if (r.ok && Object.keys(r.out).length) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(r.out));
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
    const dir = join(OUT, "yobi", yearKey);
    const file = join(dir, `${subject}.json`);
    const r = await buildSubject(
      buildYobiEntry,
      yearKey,
      subject,
      yobiTypes,
      readExisting(file),
    );
    ok += r.ok;
    skip += r.skip;
    kept += r.kept;
    if (r.ok && Object.keys(r.out).length) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(r.out));
    }
  }
}

console.log(`\n完了: ${ok}件 生成 / ${kept}件 既存を保持 / ${skip}件 未取得`);
