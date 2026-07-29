// =============================================================================
// 全文検索（事前変換データを使う・DOM非依存）
//
// converted/ 以下の事前変換済みJSON（年度×科目×種類の段落データ）を科目単位で
// まとめて取得し、キーワードに一致する年度・種類を返す。原典PDFは取得しない
// ので法務省ウェブサイトへのアクセスは発生しない。事前変換データが無い
// 年度・種類（新年度の掲載直後など）は検索できない。
//
// 取得したJSONはメモリに保持し、同じ科目の再検索では取り直さない。
// =============================================================================
import { YEAR_URL_MAP } from "./years.js";
import { YOBI_YEAR_URL_MAP } from "./yobi-years.js";
import { yearKeyToLabel } from "./data.js";

const BASE = "./converted";
const FETCH_CONCURRENCY = 6;
const SNIPPET_BEFORE = 28; // スニペットでヒット箇所の前に見せる文字数
const SNIPPET_AFTER = 60; // 同・後ろに見せる文字数

// `${exam}|${subject}` → Map(年度キー → データ | null（データ無し）)
const subjectCache = new Map();

// 検索対象の年度（新しい順）。事前変換データの有無は取得時に判定する。
export function searchYearKeys(yobi) {
  return Object.keys(yobi ? YOBI_YEAR_URL_MAP : YEAR_URL_MAP).reverse();
}

function pathFor(yobi, yearKey, subject) {
  const dir = yobi ? `${BASE}/yobi/${yearKey}` : `${BASE}/${yearKey}`;
  return `${dir}/${encodeURIComponent(subject)}.json`;
}

// 照合用の正規化。空白を除き、全角英数字などを NFKC で揃えて小文字化する。
// 正規化後の位置から元テキストの位置へ戻せるよう、対応表も併せて返す。
function normalizeWithMap(s) {
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

// 科目の全年度分を取得してキャッシュする（取得済みの年度は再取得しない）
async function loadSubject(yobi, subject, onProgress) {
  const cacheKey = `${yobi ? "yobi" : "shihou"}|${subject}`;
  let years = subjectCache.get(cacheKey);
  if (!years) {
    years = new Map();
    subjectCache.set(cacheKey, years);
  }

  const keys = searchYearKeys(yobi);
  let done = 0;
  let next = 0;
  const runners = [];
  for (let i = 0; i < Math.min(FETCH_CONCURRENCY, keys.length); i++) {
    runners.push(
      (async () => {
        for (let idx = next++; idx < keys.length; idx = next++) {
          const yearKey = keys[idx];
          if (!years.has(yearKey)) {
            try {
              const res = await fetch(pathFor(yobi, yearKey, subject));
              years.set(yearKey, res.ok ? await res.json() : null);
            } catch {
              years.set(yearKey, null); // 未生成・取得失敗は検索対象外
            }
          }
          onProgress && onProgress(++done, keys.length);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return years;
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
export async function searchSubject({ yobi, subjects, types, query }, onProgress) {
  const q = normalizeQuery(query);
  if (!q) return { hits: [], searchedYears: 0, missingYears: [] };

  // 科目ごとの取得を並行して進め、進捗は全科目の合計で数える
  const yearKeys = searchYearKeys(yobi);
  const totalUnits = yearKeys.length * subjects.length;
  let doneUnits = 0;
  const loaded = await Promise.all(
    subjects.map((subject) =>
      loadSubject(yobi, subject, () => {
        onProgress && onProgress(++doneUnits, totalUnits);
      }),
    ),
  );

  const hits = [];
  const missing = new Set(); // どの科目でもデータが無かった年度
  const searched = new Set();

  for (const yearKey of yearKeys) {
    for (let si = 0; si < subjects.length; si++) {
      const data = loaded[si].get(yearKey);
      if (!data) {
        if (!searched.has(yearKey)) missing.add(yearKey);
        continue;
      }
      searched.add(yearKey);
      missing.delete(yearKey);

      for (const docType of types) {
        const entry = data[docType];
        if (!entry || !Array.isArray(entry.paras)) continue;
        const text = entry.paras.join("\n");
        const { text: norm, map } = normalizeWithMap(text);

        let count = 0;
        let firstStart = -1;
        let firstEnd = -1;
        for (let from = 0; ; ) {
          const i = norm.indexOf(q, from);
          if (i === -1) break;
          if (firstStart === -1) {
            firstStart = map[i];
            firstEnd = map[i + q.length - 1] + 1;
          }
          count++;
          from = i + q.length;
        }
        if (!count) continue;

        hits.push({
          yearKey,
          yearLabel: yearKeyToLabel(yearKey),
          subject: subjects[si],
          docType,
          count,
          snippet: makeSnippet(text, firstStart, firstEnd),
          pdfUrl: entry.pdfUrl || null,
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
