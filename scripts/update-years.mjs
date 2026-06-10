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
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YEARS_JS = join(ROOT, "years.js");

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

function loadExistingMaps() {
  let src;
  try {
    src = readFileSync(YEARS_JS, "utf8");
  } catch {
    return { YEAR_URL_MAP: {}, RESULTS_URL_MAP: {} };
  }
  const pick = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`).exec(src);
    if (!m) return {};
    const map = {};
    const entryRe = /([a-z0-9]+):\s*"([^"]+)"/g;
    let e;
    while ((e = entryRe.exec(m[1]))) map[e[1]] = e[2];
    return map;
  };
  return {
    YEAR_URL_MAP: pick("YEAR_URL_MAP"),
    RESULTS_URL_MAP: pick("RESULTS_URL_MAP"),
  };
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
const existing = loadExistingMaps();
const yearMap = { ...existing.YEAR_URL_MAP };
const resultsMap = { ...existing.RESULTS_URL_MAP };

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
  } else {
    console.log(`  ${key}: 試験問題リンク未掲載のためスキップ (${pageUrl})`);
  }
}

const next = renderYearsJs(yearMap, resultsMap);
let current = "";
try {
  current = readFileSync(YEARS_JS, "utf8");
} catch {}

if (next !== current) {
  writeFileSync(YEARS_JS, next);
  console.log("CHANGED");
} else {
  console.log("UNCHANGED");
}
