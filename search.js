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

// `${exam}|${subject}` → Promise<Map(年度キー → { 種類: 文書 }) | null（索引無し）>
const indexCache = new Map();

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
  const key = `${yobi ? "yobi" : "shihou"}|${subject}`;
  let p = indexCache.get(key);
  if (!p) {
    p = fetchIndex(yobi, subject);
    indexCache.set(key, p);
    p.catch(() => {
      if (indexCache.get(key) === p) indexCache.delete(key);
    });
  }
  return p;
}

// 検索を押す前に索引を取り寄せておく（検索ダイアログを開いたときや科目を
// 選び直したときに呼ぶ）。失敗はここでは報告せず、検索の実行時に取り直す。
export function preloadSearchIndex(yobi, subjects) {
  for (const subject of subjects) loadIndex(yobi, subject).catch(() => {});
}

// ヒット箇所の前後を切り出す（一致部分は before / match / after に分けて返し、
// 呼び出し側が DOM で安全に強調表示できるようにする）
function makeSnippet(text, start, end) {
  const from = Math.max(0, start - SNIPPET_BEFORE);
  const to = Math.min(text.length, end + SNIPPET_AFTER);
  return {
    before: (from > 0 ? "…" : "") + text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to) + (to < text.length ? "…" : ""),
  };
}

// 科目（選択科目は第１問・第２問の2つ）を検索する。types は
// ["試験問題", "出題の趣旨", ...]。戻り値は年度が新しい順、同一年度では
// subjects → types の順に並んだヒット一覧。
export async function searchSubject({ yobi, subjects, types, query }) {
  const q = normalizeQuery(query);
  if (!q) return { hits: [], searchedYears: 0, missingYears: [] };

  const indexes = await Promise.all(
    subjects.map((subject) => loadIndex(yobi, subject)),
  );

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

        let count = 0;
        let first = -1;
        for (let from = 0; ; ) {
          const i = doc.norm.indexOf(q, from);
          if (i === -1) break;
          if (first === -1) first = i;
          count++;
          from = i + q.length;
        }
        if (!count) continue;

        // 最初の一致を原文の位置へ戻してスニペットを切り出す
        const start = toOriginal(doc.breaks, first);
        const end = toOriginal(doc.breaks, first + q.length - 1) + 1;
        hits.push({
          yearKey,
          yearLabel: yearKeyToLabel(yearKey),
          subject: subjects[si],
          docType,
          count,
          snippet: makeSnippet(doc.text, start, end),
          pdfUrl: doc.pdfUrl,
        });
      }
    }
  }
  return {
    hits,
    searchedYears: searched.size,
    missingYears: [...missing],
  };
}
