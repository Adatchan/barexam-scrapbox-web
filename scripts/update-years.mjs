// =============================================================================
// 法務省ウェブを巡回して years.js（年度→URL対応表）を自動更新するスクリプト
//
//   実施ハブ: https://www.moj.go.jp/jinji/shihoushiken/jinji08_00025.html
//     → 年度ごとの実施ページ → 「試験問題」リンク → YEAR_URL_MAP
//   結果ハブ: https://www.moj.go.jp/jinji/shihoushiken/jinji08_00026.html
//     → 年度ごとの結果ページ（出題の趣旨・採点実感の掲載元） → RESULTS_URL_MAP
//
// 既存エントリは保持し、新しく見つかった年度だけを追加する（ハブに載らない
// 古い年度、例: 平成22年の実施ページを消さないため）。
//
// 使い方: node scripts/update-years.mjs
// 変更があれば years.js を書き換えて "CHANGED" を、なければ "UNCHANGED" を出力。
// =============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isThreeSubjectYear,
  findTantouQuestionPdfUrl,
  findTantouAnswerPdfUrl,
} from "../tantou-moj.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YEARS_JS = join(ROOT, "years.js");
const NEWS_JS = join(ROOT, "news.js");

const JISSHI_HUB = "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00025.html";
const KEKKA_HUB = "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00026.html";

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.text();
}

function resolveUrl(href, baseUrl) {
  if (/^https?:/.test(href)) return href;
  return new URL(href, baseUrl).toString();
}

// 「令和８年」「令和元年」「平成３０年」→ "r8" / "r1" / "h30"
function yearLabelToKey(label) {
  const m = /^(令和|平成)([元０-９0-9]+)年$/.exec(label.trim());
  if (!m) return null;
  const era = m[1] === "令和" ? "r" : "h";
  const digits = m[2];
  const num =
    digits === "元"
      ? 1
      : Number(
          digits.replace(/[０-９]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xfee0),
          ),
        );
  if (!Number.isInteger(num) || num < 1) return null;
  return era + num;
}

// ハブページから { yearKey: 年度ページURL } を作る
function parseHub(html, baseUrl) {
  const map = {};
  const re = /<a [^>]*href="([^"]+\.html)"[^>]*>\s*((?:令和|平成)[元０-９0-9]+年)\s*</g;
  let m;
  while ((m = re.exec(html))) {
    const key = yearLabelToKey(m[2]);
    if (key && !(key in map)) map[key] = resolveUrl(m[1], baseUrl);
  }
  return map;
}

// 実施ページから「試験問題」リンクを探す
function findExamPageUrl(html, baseUrl) {
  const re = /<a [^>]*href="([^"#]+\.html)"[^>]*>\s*([^<]*試験問題[^<]*)</g;
  let m;
  while ((m = re.exec(html))) {
    const text = m[2].trim();
    // 「試験問題に関する過去の検討等」のような別ページを除外
    if (/検討|窓口|決定/.test(text)) continue;
    return resolveUrl(m[1], baseUrl);
  }
  return null;
}

const rank = (k) => {
  const era = k[0] === "h" ? 0 : 1;
  return era * 1000 + Number(k.slice(1));
};

// 平成21年以前（新司法試験初期）はページ構造・PDF書式の動作検証をして
// いないため自動追加の対象外とする
const MIN_RANK = rank("h22");

// 年度キーの昇順ソート（h22 → … → r7 → r8）。
// initSelectors() が Object.keys(...).reverse() でプルダウンを作るため、
// 昇順を保つことが必須。
function sortKeys(keys) {
  return [...keys].sort((a, b) => rank(a) - rank(b));
}

// "r8" → 令和8年 / "r1" → 令和元年 / "h30" → 平成30年
function yearKeyToLabel(key) {
  const era = key[0] === "r" ? "令和" : "平成";
  const n = Number(key.slice(1));
  return `${era}${era === "令和" && n === 1 ? "元" : n}年`;
}

// JST の今日の日付を "YYYY.MM.DD" で返す
function todayJst() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}.${get("month")}.${get("day")}`;
}

function renderNewsJs(news, state, tantouNews, tantouState) {
  const renderNews = (arr) =>
    arr
      .map(
        (n) =>
          `  { date: ${JSON.stringify(n.date)}, text: ${JSON.stringify(n.text)} },`,
      )
      .join("\n");
  const stateLines = sortKeys(Object.keys(state))
    .map((k) => `  ${k}: { shushi: ${!!state[k].shushi}, saiten: ${!!state[k].saiten} },`)
    .join("\n");
  const tantouStateLines = sortKeys(Object.keys(tantouState))
    .map(
      (k) =>
        `  ${k}: { mondai: ${!!tantouState[k].mondai}, seikai: ${!!tantouState[k].seikai} },`,
    )
    .join("\n");
  return `// =============================================================================
// 更新情報
//
// このファイルは scripts/update-years.mjs により自動更新されます。
// NEWS / TANTOU_NEWS: 各画面の「更新情報」欄に表示されるお知らせ（新しい順）
//   - NEWS        … 論文式（index.html）
//   - TANTOU_NEWS … 短答式（tantou.html）
// CRAWL_STATE / TANTOU_CRAWL_STATE: 年度ごとの掲載を確認済みかの記録
//   （未確認の項目だけを週次クロールで再チェックする）
//   - CRAWL_STATE        … 論文式の 出題の趣旨(shushi)・採点実感(saiten)
//   - TANTOU_CRAWL_STATE … 短答式の 問題(mondai)・正答及び配点(seikai)
// =============================================================================

export const NEWS = [
${renderNews(news)}
];

export const CRAWL_STATE = {
${stateLines}
};

export const TANTOU_NEWS = [
${renderNews(tantouNews)}
];

export const TANTOU_CRAWL_STATE = {
${tantouStateLines}
};
`;
}

function renderYearsJs(yearMap, resultsMap) {
  const renderMap = (map) =>
    sortKeys(Object.keys(map))
      .map((k) => `  ${k}: "${map[k]}",`)
      .join("\n");
  return `// =============================================================================
// 年度 → 法務省ページ URL 対応表
//
// このファイルは scripts/update-years.mjs により自動生成・更新されます。
// 手で編集しても次回の自動更新で新年度の追記が行われます（既存行は保持）。
// =============================================================================

// 試験問題ページ（論文式試験問題 PDF の掲載元）
export const YEAR_URL_MAP = {
${renderMap(yearMap)}
};

// 結果ページ（出題の趣旨・採点実感の掲載元）
export const RESULTS_URL_MAP = {
${renderMap(resultsMap)}
};
`;
}

// ─── メイン ────────────────────────────────────────────────────────────────
// 既存の対応表は years.js（純粋なデータ ESM）を import で読む
const existing = await import(pathToFileURL(YEARS_JS).href).then(
  (m) => ({
    YEAR_URL_MAP: m.YEAR_URL_MAP ?? {},
    RESULTS_URL_MAP: m.RESULTS_URL_MAP ?? {},
  }),
  () => ({ YEAR_URL_MAP: {}, RESULTS_URL_MAP: {} }),
);
const yearMap = { ...existing.YEAR_URL_MAP };
const resultsMap = { ...existing.RESULTS_URL_MAP };

// 更新情報と巡回状態（news.js は純粋なデータ ESM なので import で読む）
const {
  NEWS: news,
  CRAWL_STATE: state,
  TANTOU_NEWS: tantouNews,
  TANTOU_CRAWL_STATE: tantouState,
} = await import(pathToFileURL(NEWS_JS).href).then(
  (m) => ({
    NEWS: [...m.NEWS],
    CRAWL_STATE: structuredClone(m.CRAWL_STATE),
    TANTOU_NEWS: [...(m.TANTOU_NEWS ?? [])],
    TANTOU_CRAWL_STATE: structuredClone(m.TANTOU_CRAWL_STATE ?? {}),
  }),
  () => ({ NEWS: [], CRAWL_STATE: {}, TANTOU_NEWS: [], TANTOU_CRAWL_STATE: {} }),
);
const addNews = (text) => {
  news.unshift({ date: todayJst(), text });
  console.log(`+ NEWS: ${text}`);
};
const addTantouNews = (text) => {
  tantouNews.unshift({ date: todayJst(), text });
  console.log(`+ TANTOU_NEWS: ${text}`);
};

// 結果ハブ: 年度ページ URL をそのまま採用
const kekkaHub = parseHub(await fetchHtml(KEKKA_HUB), KEKKA_HUB);
if (Object.keys(kekkaHub).length === 0)
  throw new Error("結果ハブから年度リンクを抽出できませんでした（ページ構造変更の可能性）");
for (const [key, url] of Object.entries(kekkaHub)) {
  if (rank(key) < MIN_RANK) continue;
  if (!(key in resultsMap)) {
    resultsMap[key] = url;
    console.log(`+ RESULTS_URL_MAP ${key}: ${url}`);
  }
}

// 実施ハブ: 年度ページを開いて「試験問題」リンクを解決
const jisshiHub = parseHub(await fetchHtml(JISSHI_HUB), JISSHI_HUB);
if (Object.keys(jisshiHub).length === 0)
  throw new Error("実施ハブから年度リンクを抽出できませんでした（ページ構造変更の可能性）");
for (const [key, pageUrl] of Object.entries(jisshiHub)) {
  if (rank(key) < MIN_RANK) continue;
  if (key in yearMap) continue;
  const examUrl = findExamPageUrl(await fetchHtml(pageUrl), pageUrl);
  if (examUrl) {
    yearMap[key] = examUrl;
    console.log(`+ YEAR_URL_MAP ${key}: ${examUrl}`);
    addNews(`${yearKeyToLabel(key)}の試験問題が掲載されました。`);
  } else {
    console.log(`  ${key}: 試験問題リンク未掲載のためスキップ (${pageUrl})`);
  }
}

// 出題の趣旨・採点実感の掲載チェック（未確認の年度だけ結果ページを見に行く）
for (const key of sortKeys(Object.keys(resultsMap))) {
  if (rank(key) < MIN_RANK) continue;
  const st = (state[key] ??= { shushi: false, saiten: false });
  if (st.shushi && st.saiten) continue;
  const html = await fetchHtml(resultsMap[key]);
  if (!st.shushi && /href="[^"]+"[^>]*>[^<]*出題の趣旨/.test(html)) {
    st.shushi = true;
    addNews(`${yearKeyToLabel(key)}の出題の趣旨が掲載されました。`);
  }
  if (!st.saiten && /href="[^"]+"[^>]*>[^<]*採点実感/.test(html)) {
    st.saiten = true;
    addNews(`${yearKeyToLabel(key)}の採点実感が掲載されました。`);
  }
}

// 短答式（憲法・民法・刑法の3科目制 = 平成27年以降）の掲載チェック。
// 問題は試験問題ページの《短答式試験》区分に、正答及び配点は結果ページ →
// 「短答式試験」サブページに、それぞれ憲法のリンクが現れるかで判定する
// （3科目同時掲載のため代表として憲法で確認）。未確認の項目だけ見に行く。
for (const key of sortKeys(Object.keys(yearMap))) {
  if (rank(key) < MIN_RANK || !isThreeSubjectYear(key)) continue;
  const st = (tantouState[key] ??= { mondai: false, seikai: false });
  if (st.mondai && st.seikai) continue;
  if (!st.mondai) {
    try {
      await findTantouQuestionPdfUrl(yearMap[key], "憲法");
      st.mondai = true;
      addTantouNews(`${yearKeyToLabel(key)}の短答式問題が掲載されました。`);
    } catch {
      /* 短答式問題が未掲載のページ構造のためスキップ */
    }
  }
  if (!st.seikai && resultsMap[key]) {
    try {
      await findTantouAnswerPdfUrl(resultsMap[key], "憲法");
      st.seikai = true;
      addTantouNews(
        `${yearKeyToLabel(key)}の短答式の正答及び配点が掲載されました。`,
      );
    } catch {
      /* 正答及び配点が未掲載のためスキップ */
    }
  }
}

// ─── 書き出し ──────────────────────────────────────────────────────────────
let changed = false;
const writeIfChanged = (path, next) => {
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (next !== current) {
    writeFileSync(path, next);
    changed = true;
  }
};

writeIfChanged(YEARS_JS, renderYearsJs(yearMap, resultsMap));
writeIfChanged(NEWS_JS, renderNewsJs(news, state, tantouNews, tantouState));
console.log(changed ? "CHANGED" : "UNCHANGED");
