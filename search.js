// =============================================================================
// 全文検索（事前に正規化した検索用索引を使う・DOM非依存）
//
// 検索用索引（converted/search/<試験>/<科目>.json）は、事前変換データ
// （converted/<年度>/<科目>.json）から scripts/build-search-index.mjs が作る。
// 科目の全年度分の本文を照合用に正規化済みの形で持つので、ブラウザは科目ごとに
// 1ファイルを取得し、正規化済みの本文を indexOf で照合するだけで済む（検索の
// たびに本文を正規化し直さない）。原典PDFは取得しないので法務省ウェブサイト
// へのアクセスは発生しない。索引に無い年度・種類（新年度の掲載直後など）は
// 検索できない。
//
// キーワードは空白で区切ると複数の語になり、すべての語を含む文書（年度×種類）
// だけを残す（AND検索）。照合が軽いので、画面側は入力に合わせて順次検索できる。
//
// 正規化の規則と索引の形式（作る側 buildSearchDoc・読む側 openDoc）はこの
// ファイルで定義し、索引を作るスクリプトと共有する。取得した索引はメモリに
// 保持し、同じ科目の再検索では取り直さない。
// =============================================================================
import { YEAR_URL_MAP } from "./years.js";
import { YOBI_YEAR_URL_MAP } from "./yobi-years.js";
import { yearKeyToLabel } from "./data.js";

// 索引の形式か正規化の規則を変えたら上げる（古い索引のまま照合しないように）
export const SEARCH_INDEX_VERSION = 1;

const BASE = "./converted";
const SNIPPET_BEFORE = 28; // スニペットでヒット箇所の前に見せる文字数
const SNIPPET_AFTER = 60; // 同・後ろに見せる文字数
// 複数語のときは語ごとに抜粋の窓を作るので、1つの窓を短めにする
const SNIPPET_MULTI_BEFORE = 16;
const SNIPPET_MULTI_AFTER = 32;
export const SNIPPET_MAX_WINDOWS = 4; // 1枚のカードに並べる抜粋の窓の上限

// `${exam}|${subject}` → Promise<Map(年度キー → { 種類: 文書 }) | null（索引無し）>
const indexCache = new Map();
const loadedKeys = new Set(); // 読み込みを終えた索引（索引が無い科目も含む）
let loadListener = null; // 索引の読み込みにかかった時間を知らせる先（画面側）

const now = () => globalThis.performance?.now() ?? Date.now();
const indexKey = (yobi, subject) => `${yobi ? "yobi" : "shihou"}|${subject}`;

// 検索対象の年度（新しい順）。索引に無い年度は検索対象外として数える。
export function searchYearKeys(yobi) {
  return Object.keys(yobi ? YOBI_YEAR_URL_MAP : YEAR_URL_MAP).reverse();
}

// converted/ 内の索引の置き場所（司法と予備で科目名が衝突するため分ける）
export function searchIndexDir(yobi) {
  return yobi ? "search/yobi" : "search/shihou";
}

// 照合用の正規化。空白を除き、全角英数字などを NFKC で揃えて小文字化する。
// 正規化後の位置から元テキストの位置へ戻せるよう、対応表も併せて返す。
export function normalizeWithMap(s) {
  const chars = [];
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[\s　]/.test(ch)) continue;
    for (const c of ch.normalize("NFKC").toLowerCase()) {
      chars.push(c);
      map.push(i);
    }
  }
  return { text: chars.join(""), map };
}

export function normalizeQuery(q) {
  return normalizeWithMap(q).text;
}

// キーワードを空白（半角・全角）で区切って検索語にする。raw は表示用の入力
// どおりの語、norm は照合用。正規化すると同じになる語は1つにまとめる。
export function parseQuery(query) {
  const terms = [];
  const seen = new Set();
  for (const raw of String(query).split(/[\s　]+/)) {
    const norm = normalizeQuery(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    terms.push({ raw, norm });
  }
  return terms;
}

// ─── 索引の形式 ──────────────────────────────────────────────────────────
// 1文書（年度×科目×種類）は { pdfUrl, paras, breaks }。
//   paras:  [[原文の段落, 正規化後の段落], ...]。原文と正規化後を段落ごとに
//           並べるのは、gzip が近くにある似た文字列をまとめて圧縮できるように
//           するため（本文ごと離して置くより配信量が小さくなる）。
//   本文:   原文は段落を "\n" で、正規化後は区切り無しで連結したもの。改行も
//           空白として除くので、照合は段落をまたいでも一致する。
//   breaks: 正規化後の位置を原文の位置へ戻す表 [位置, ずれ, 位置, ずれ, ...]。
//           正規化後の位置 i の文字は「i 以下で最後の位置」のずれを i に足した
//           原文の位置から来ている（最初の区切りより前はずれ 0）。ずれは空白を
//           除いたところと、1文字が複数文字になったところ（⑴ → (1) など）で
//           しか変わらないので、全文字分の対応表より桁違いに小さい。
export function buildSearchDoc(paras) {
  const pairs = [];
  const breaks = [];
  let base = 0; // 段落の先頭の原文位置
  let pos = 0; // 正規化後の位置
  let shift = 0; // 直前のずれ（原文位置 − 正規化後の位置）
  for (const para of paras) {
    const { text, map } = normalizeWithMap(para);
    pairs.push([para, text]);
    for (let i = 0; i < map.length; i++, pos++) {
      const d = base + map[i] - pos;
      if (d !== shift) {
        breaks.push(pos, d);
        shift = d;
      }
    }
    base += para.length + 1; // "\n" の1文字分
  }
  return { paras: pairs, breaks };
}

function openDoc(doc) {
  return {
    text: doc.paras.map((p) => p[0]).join("\n"),
    norm: doc.paras.map((p) => p[1]).join(""),
    breaks: doc.breaks,
    pdfUrl: doc.pdfUrl || null,
  };
}

// 正規化後の位置 → 原文の位置（breaks を二分探索する）
export function toOriginal(breaks, i) {
  let lo = 0;
  let hi = breaks.length / 2; // 区切りの数
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[2 * mid] <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo ? i + breaks[2 * lo - 1] : i;
}

// ─── 索引の取得 ──────────────────────────────────────────────────────────
async function fetchIndex(yobi, subject) {
  const url = `${BASE}/${searchIndexDir(yobi)}/${encodeURIComponent(subject)}.json`;
  const res = await fetch(url, { cache: "no-cache" });
  if (res.status === 404) return null; // 索引が無い科目は全年度が検索対象外
  if (!res.ok)
    throw new Error(`検索用データを取得できませんでした（HTTP ${res.status}）`);
  const index = await res.json();
  if (index.version !== SEARCH_INDEX_VERSION)
    throw new Error(
      "検索用データの形式が合いません。ページを再読み込みしてください。",
    );
  const years = new Map();
  for (const [yearKey, docs] of Object.entries(index.years)) {
    const opened = {};
    for (const [docType, doc] of Object.entries(docs))
      opened[docType] = openDoc(doc);
    years.set(yearKey, opened);
  }
  return years;
}

// 科目の索引を取得してキャッシュする（取得中・取得済みなら同じものを返す）。
// 通信の失敗は覚えておかず、次の検索で取り直す。
function loadIndex(yobi, subject) {
  const key = indexKey(yobi, subject);
  let p = indexCache.get(key);
  if (!p) {
    const t0 = now();
    p = fetchIndex(yobi, subject);
    indexCache.set(key, p);
    p.then(
      () => {
        loadedKeys.add(key);
        loadListener?.({ ms: now() - t0 });
      },
      () => {
        if (indexCache.get(key) === p) indexCache.delete(key);
      },
    );
  }
  return p;
}

// 検索を押す前に索引を取り寄せておく（検索ダイアログを開いたときや科目を
// 選び直したときに呼ぶ）。失敗はここでは報告せず、検索の実行時に取り直す。
export function preloadSearchIndex(yobi, subjects) {
  return Promise.allSettled(subjects.map((s) => loadIndex(yobi, s)));
}

// 科目の索引をすべて読み込み済みか（入力中に検索しても通信が発生しないか）
export function isSearchIndexLoaded(yobi, subjects) {
  return subjects.every((s) => loadedKeys.has(indexKey(yobi, s)));
}

// 索引を読み込むたびに、かかった時間（通信と展開）を fn({ ms }) で知らせる。
// 画面側が通信の速さを見積もり、検索の方式を切り替えるのに使う。
export function onSearchIndexLoad(fn) {
  loadListener = fn;
}

// 文書を照合する。すべての語を含めば語ごとの件数と最初の位置を、1つでも
// 含まなければ null を返す（件数は重ならない一致を数える）。
function matchDoc(norm, terms) {
  const firsts = [];
  for (const { norm: q } of terms) {
    const i = norm.indexOf(q);
    if (i === -1) return null;
    firsts.push(i);
  }
  const counts = terms.map(({ norm: q }, k) => {
    let n = 0;
    for (let i = firsts[k]; i !== -1; i = norm.indexOf(q, i + q.length)) n++;
    return n;
  });
  return { counts, firsts };
}

// 原文の一部を、検索語に一致する部分（mark）とそれ以外に分ける。重なり合う
// 一致（「伝聞」と「聞証」など）は1つの強調にまとめる。
function highlight(text, terms) {
  const { text: norm, map } = normalizeWithMap(text);
  const ranges = [];
  for (const { norm: q } of terms) {
    for (let i = norm.indexOf(q); i !== -1; i = norm.indexOf(q, i + q.length))
      ranges.push([map[i], map[i + q.length - 1] + 1]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const marks = [];
  for (const r of ranges) {
    const last = marks[marks.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else marks.push(r);
  }
  const parts = [];
  let pos = 0;
  for (const [s, e] of marks) {
    if (s > pos) parts.push({ text: text.slice(pos, s) });
    parts.push({ text: text.slice(s, e), mark: true });
    pos = e;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) });
  return parts;
}

// ヒットした文書の抜粋を作る。部品の配列 [{ text, mark?, gap? }] を返し、
// 呼び出し側が DOM で安全に強調表示できるようにする（gap は省略の「…」）。
// 語ごとに1か所を選んで前後を切り出し、重なる窓は1つにまとめる。選ぶのは、
// 最も件数の少ない語の最初の一致と、ほかの語ではそこにいちばん近い一致
// （語が近くに並んでいる箇所があれば1つの窓にまとまる）。窓の中では、
// すべての語の一致を強調する。
function makeSnippet(doc, terms, { counts, firsts }) {
  let base = 0;
  for (let k = 1; k < terms.length; k++) if (counts[k] < counts[base]) base = k;
  const a = firsts[base];
  const aEnd = a + terms[base].norm.length;
  const anchors = terms.map(({ norm: q }, k) => {
    if (k === base) return a;
    const before = doc.norm.lastIndexOf(q, a);
    const after = doc.norm.indexOf(q, a);
    if (before === -1) return after;
    if (after === -1) return before;
    return a - (before + q.length) <= after - aEnd ? before : after;
  });

  const multi = terms.length > 1;
  const pre = multi ? SNIPPET_MULTI_BEFORE : SNIPPET_BEFORE;
  const post = multi ? SNIPPET_MULTI_AFTER : SNIPPET_AFTER;
  const wins = anchors
    .map((p, k) => [
      toOriginal(doc.breaks, p),
      toOriginal(doc.breaks, p + terms[k].norm.length - 1) + 1,
    ])
    .sort((x, y) => x[0] - y[0])
    .map(([s, e]) => [Math.max(0, s - pre), Math.min(doc.text.length, e + post)]);
  const merged = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push(w);
  }
  merged.length = Math.min(merged.length, SNIPPET_MAX_WINDOWS);

  const parts = [];
  merged.forEach(([from, to], i) => {
    if (i > 0 || from > 0) parts.push({ text: "…", gap: true });
    parts.push(...highlight(doc.text.slice(from, to), terms));
  });
  if (merged[merged.length - 1][1] < doc.text.length)
    parts.push({ text: "…", gap: true });
  return parts;
}

// 科目（選択科目は第１問・第２問の2つ）を検索する。types は
// ["試験問題", "出題の趣旨", ...]。query は空白で区切ると AND 検索になる。
// 戻り値の hits は年度が新しい順、同一年度では subjects → types の順に並び、
// counts は terms（検索語）ごとの件数。matchMs は索引の読み込みを除いた
// 照合にかかった時間（画面側が処理の速さを見積もるのに使う）。
export async function searchSubject({ yobi, subjects, types, query }) {
  const terms = parseQuery(query);
  if (!terms.length)
    return { hits: [], searchedYears: 0, missingYears: [], terms, matchMs: 0 };

  const indexes = await Promise.all(
    subjects.map((subject) => loadIndex(yobi, subject)),
  );
  const t0 = now();

  const hits = [];
  const missing = new Set(); // どの科目でもデータが無かった年度
  const searched = new Set();

  for (const yearKey of searchYearKeys(yobi)) {
    for (let si = 0; si < subjects.length; si++) {
      const docs = indexes[si]?.get(yearKey);
      if (!docs) {
        if (!searched.has(yearKey)) missing.add(yearKey);
        continue;
      }
      searched.add(yearKey);
      missing.delete(yearKey);

      for (const docType of types) {
        const doc = docs[docType];
        if (!doc) continue;
        const m = matchDoc(doc.norm, terms);
        if (!m) continue;
        hits.push({
          yearKey,
          yearLabel: yearKeyToLabel(yearKey),
          subject: subjects[si],
          docType,
          counts: m.counts,
          snippet: makeSnippet(doc, terms, m),
          pdfUrl: doc.pdfUrl,
        });
      }
    }
  }
  return {
    hits,
    searchedYears: searched.size,
    missingYears: [...missing],
    terms,
    matchMs: now() - t0,
  };
}
