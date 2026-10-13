// =============================================================================
// 全文検索の索引を作る: 事前変換データ（converted/<年度>/<科目>.json）から、
// 科目ごとに全年度分の本文を照合用に正規化した索引を書き出す。
//   司法試験: converted/search/shihou/<科目>.json
//   予備試験: converted/search/yobi/<科目>.json
//
// ブラウザ（search.js）は検索のたびに本文を正規化し直さず、この索引の正規化
// 済みテキストをそのまま照合する。正規化の規則と索引の形式は search.js が
// 定義する（ここは事前変換データを読んで書き出すだけ）。
//
// precompute.mjs の最後に自動で実行される。converted/ を手で直したときは
// これだけを実行すればよい（PDFの取得・解析はしないので数秒で終わる）。
// コミットフック（.githooks/pre-commit）も converted/ か search.js が変わった
// コミットで自動実行する。
//
// 使い方:
//   node scripts/build-search-index.mjs          # 索引を作り直す
//   node scripts/build-search-index.mjs --check  # 索引が最新か確かめる（古ければ終了コード1）
// =============================================================================
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SEARCH_INDEX_VERSION,
  buildSearchDoc,
  searchIndexDir,
} from "../search.js";
import { SUBJECT_MAP } from "../data.js";
import { YEAR_URL_MAP } from "../years.js";
import { YOBI_YEAR_URL_MAP } from "../yobi-years.js";
import { YOBI_RONBUN_SUBJECTS } from "../yobi-moj.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONVERTED = join(ROOT, "converted");

// 試験ごとの年度・科目と、事前変換データの置き場所（precompute.mjs と同じ）
const EXAMS = [
  {
    yobi: false,
    years: Object.keys(YEAR_URL_MAP),
    subjects: Object.keys(SUBJECT_MAP),
    dirOf: (yearKey) => join(CONVERTED, yearKey),
  },
  {
    yobi: true,
    years: Object.keys(YOBI_YEAR_URL_MAP),
    subjects: YOBI_RONBUN_SUBJECTS,
    dirOf: (yearKey) => join(CONVERTED, "yobi", yearKey),
  },
];

// 1科目分の索引（JSON文字列）。事前変換データが無い年度は索引に含めず、
// 検索側で「データが無い年度」として数える。
function buildSubjectIndex({ years, dirOf }, subject) {
  const out = {};
  for (const yearKey of years) {
    const file = join(dirOf(yearKey), `${subject}.json`);
    if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, "utf8"));
    const docs = {};
    for (const [docType, entry] of Object.entries(data)) {
      if (!entry || !Array.isArray(entry.paras)) continue;
      docs[docType] = {
        pdfUrl: entry.pdfUrl || null,
        ...buildSearchDoc(entry.paras),
      };
    }
    out[yearKey] = docs;
  }
  return JSON.stringify({ version: SEARCH_INDEX_VERSION, years: out });
}

// 全科目の索引を作り直す。check=true のときは書き込まず、古い索引
// （作り直すと変わるもの・科目定義から消えた科目のもの）を stale に挙げる。
export function buildSearchIndexes({ check = false } = {}) {
  let written = 0;
  let unchanged = 0;
  let removed = 0;
  const stale = [];
  for (const exam of EXAMS) {
    const outDir = join(CONVERTED, searchIndexDir(exam.yobi));
    const expected = new Set();
    for (const subject of exam.subjects) {
      const name = `${subject}.json`;
      const file = join(outDir, name);
      expected.add(name);
      const json = buildSubjectIndex(exam, subject);
      if (existsSync(file) && readFileSync(file, "utf8") === json) {
        unchanged++;
        continue;
      }
      if (check) {
        stale.push(file);
        continue;
      }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, json);
      written++;
    }
    if (!existsSync(outDir)) continue;
    for (const name of readdirSync(outDir)) {
      if (expected.has(name)) continue;
      if (check) {
        stale.push(join(outDir, name));
        continue;
      }
      rmSync(join(outDir, name));
      removed++;
    }
  }
  return { written, unchanged, removed, stale };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const r = buildSearchIndexes({ check });
  if (check) {
    for (const file of r.stale) console.log(`古い索引: ${file}`);
    if (r.stale.length) {
      console.log(
        "全文検索の索引が事前変換データと合っていません。" +
          "node scripts/build-search-index.mjs で作り直してください。",
      );
      process.exit(1);
    }
    console.log(`全文検索の索引は最新です（${r.unchanged}件）`);
  } else {
    console.log(
      `全文検索の索引: ${r.written}件 更新 / ${r.unchanged}件 変更なし` +
        (r.removed ? ` / ${r.removed}件 削除` : ""),
    );
  }
}
