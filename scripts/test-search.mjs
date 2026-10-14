// 全文検索の回帰テスト（外部依存なしで動く）
//
//   ・索引（converted/search/）が、事前変換データ（converted/）から作り直した
//     ものと一致する（converted/ を直して索引を作り直し忘れた、を検出する）。
//   ・索引の正規化済みテキストと位置の対応表が、原文をその場で正規化した結果と
//     全文字で一致する。
//   ・索引を使った検索（search.js）が、本文をその場で正規化して照合する素朴な
//     方法と同じ年度・種類・語ごとの件数を返す（空白で区切った語は AND 検索）。
//     キーワードは固定の例と、本文から決まった手順で切り出した部分文字列を使う。
//   ・抜粋が本文の一部で、強調した部分がすべて検索語の一致でできていて、
//     各語が強調される。1語なら最初の強調は最初の一致と同じ箇所になる。
//
// 使い方: node scripts/test-search.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSearchDoc,
  normalizeQuery,
  normalizeWithMap,
  parseQuery,
  SNIPPET_MAX_WINDOWS,
  searchIndexDir,
  searchSubject,
  searchYearKeys,
  toOriginal,
} from "../search.js";
import { SUBJECT_MAP, subjectSearchGroups } from "../data.js";
import { YOBI_RONBUN_SUBJECTS } from "../yobi-moj.js";
import { buildSearchIndexes } from "./build-search-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let ng = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "OK " : "NG "} ${label}`);
  if (!cond) ng++;
};

// ─── 正規化と位置の対応 ─────────────────────────────────────────────────
ok(
  normalizeQuery("Ａ　ｂ １\n２") === "ab12",
  "空白を除き全角英数字を半角小文字に揃える",
);
ok(
  JSON.stringify(parseQuery(" Ａ　ｂ  a\n伝聞 ")) ===
    JSON.stringify([
      { raw: "Ａ", norm: "a" },
      { raw: "ｂ", norm: "b" },
      { raw: "伝聞", norm: "伝聞" },
    ]),
  "キーワードを空白（全角・改行を含む）で区切り、同じ語は1つにまとめる",
);
{
  // 空白の除去（段落区切りの "\n" を含む）と、1文字が3文字になる ⑴ → (1)
  const { paras, breaks } = buildSearchDoc(["Ａ ⑴", "ｂ"]);
  const norm = paras.map((p) => p[1]).join("");
  const back = [...norm].map((_, i) => toOriginal(breaks, i));
  ok(
    norm === "a(1)b" && back.join(",") === "0,2,2,2,4",
    "正規化後の位置を原文の位置へ戻せる",
  );
}

// ─── 索引が最新か ───────────────────────────────────────────────────────
const { stale } = buildSearchIndexes({ check: true });
ok(
  stale.length === 0,
  `索引が事前変換データと一致する（古い索引 ${stale.length}件）`,
);

// ─── 索引の中身を全文字で照合 ───────────────────────────────────────────
{
  let docs = 0;
  let chars = 0;
  const bad = [];
  for (const yobi of [false, true]) {
    const dir = join(ROOT, "converted", searchIndexDir(yobi));
    for (const name of readdirSync(dir)) {
      const index = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const [yearKey, byType] of Object.entries(index.years)) {
        for (const [docType, doc] of Object.entries(byType)) {
          docs++;
          const text = doc.paras.map((p) => p[0]).join("\n");
          const norm = doc.paras.map((p) => p[1]).join("");
          const plain = normalizeWithMap(text);
          chars += norm.length;
          let same = norm === plain.text;
          for (let i = 0; same && i < norm.length; i++)
            same = toOriginal(doc.breaks, i) === plain.map[i];
          if (!same) bad.push(`${name} ${yearKey} ${docType}`);
        }
      }
    }
  }
  for (const b of bad.slice(0, 5)) console.log(`    不一致: ${b}`);
  ok(
    docs > 0 && bad.length === 0,
    `索引の正規化と位置の対応が原文と一致する（${docs}文書・${chars}文字）`,
  );
}

// ─── 検索結果を素朴な方法と突き合わせる ─────────────────────────────────
// search.js は ./converted/... を fetch するので、ローカルのファイルを返す
globalThis.fetch = async (url) => {
  const file = join(ROOT, decodeURIComponent(url));
  if (!existsSync(file)) return { ok: false, status: 404 };
  const body = readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
};

const EXAMS = [
  {
    yobi: false,
    subjects: Object.keys(SUBJECT_MAP),
    types: ["試験問題", "出題の趣旨", "採点実感"],
    dirOf: (yearKey) => join(ROOT, "converted", yearKey),
  },
  {
    yobi: true,
    subjects: YOBI_RONBUN_SUBJECTS,
    types: ["試験問題", "出題の趣旨"],
    dirOf: (yearKey) => join(ROOT, "converted", "yobi", yearKey),
  },
];

// 事前変換データを読み、本文をその場で正規化しておく（年度キー → 種類 → 文書）
function loadPlain(exam, subject) {
  const years = new Map();
  for (const yearKey of searchYearKeys(exam.yobi)) {
    const file = join(exam.dirOf(yearKey), `${subject}.json`);
    if (!existsSync(file)) continue;
    const docs = {};
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const [docType, entry] of Object.entries(data)) {
      if (!entry || !Array.isArray(entry.paras)) continue;
      const text = entry.paras.join("\n");
      const { text: norm, map } = normalizeWithMap(text);
      docs[docType] = { text, norm, map };
    }
    years.set(yearKey, docs);
  }
  return years;
}

// 空白で区切って正規化した検索語（search.js の parseQuery とは別に書く）
function plainTerms(query) {
  const terms = query.split(/[\s　]+/).map(normalizeQuery).filter(Boolean);
  return [...new Set(terms)];
}

// 本文を毎回そのまま照合する素朴な検索（索引を使う前の方式と同じ規則）。
// すべての語を含む文書だけを残し、語ごとに重ならない一致を数える。
function plainSearch(yobi, plainBySubject, subjects, types, query) {
  const terms = plainTerms(query);
  const hits = [];
  const missing = new Set();
  const searched = new Set();
  for (const yearKey of searchYearKeys(yobi)) {
    for (const subject of subjects) {
      const docs = plainBySubject.get(subject).get(yearKey);
      if (!docs) {
        if (!searched.has(yearKey)) missing.add(yearKey);
        continue;
      }
      searched.add(yearKey);
      missing.delete(yearKey);
      for (const docType of types) {
        const d = docs[docType];
        if (!d) continue;
        const counts = [];
        const matches = [];
        for (const q of terms) {
          let count = 0;
          for (let from = 0; ; ) {
            const i = d.norm.indexOf(q, from);
            if (i === -1) break;
            if (!count)
              matches.push(d.text.slice(d.map[i], d.map[i + q.length - 1] + 1));
            count++;
            from = i + q.length;
          }
          counts.push(count);
        }
        if (counts.every(Boolean))
          hits.push({ yearKey, subject, docType, counts, matches });
      }
    }
  }
  return { hits, searchedYears: searched.size, missingYears: [...missing] };
}

// 抜粋の検査。問題があれば理由を返す（無ければ ""）。
//   ・「…」で区切った各窓が本文の一部である
//   ・強調した部分は、検索語の一致（重なりはまとめる）だけでできている
//   ・各語がどこかで強調される（窓の上限を超えない語数のとき）
//   ・1語なら最初の強調が最初の一致と同じ箇所
function checkSnippet(snippet, text, terms, firstMatch) {
  const windows = [[]];
  for (const part of snippet) {
    if (part.gap) windows.push([]);
    else windows[windows.length - 1].push(part);
  }
  for (const w of windows) {
    if (w.length && !text.includes(w.map((p) => p.text).join("")))
      return "窓が本文の一部でない";
  }
  // 1文字が複数文字になる記号（⒜ → (a) など）の一部に一致したときは、その
  // 記号ごと強調するので、原文の1文字ごとに「一部でも一致に含まれるか」で見る
  const marks = snippet.filter((p) => p.mark).map((p) => normalizeQuery(p.text));
  for (const part of snippet.filter((p) => p.mark)) {
    const { text: m, map } = normalizeWithMap(part.text);
    const hit = new Set();
    for (const q of terms) {
      for (let i = m.indexOf(q); i !== -1; i = m.indexOf(q, i + 1))
        for (let j = i; j < i + q.length; j++) hit.add(map[j]);
    }
    if (!m || map.some((orig) => !hit.has(orig)))
      return `強調「${part.text}」が検索語でない`;
  }
  if (terms.length <= SNIPPET_MAX_WINDOWS) {
    for (const q of terms)
      if (!marks.some((m) => m.includes(q))) return `「${q}」が強調されない`;
  }
  if (terms.length === 1) {
    const first = snippet.find((p) => p.mark);
    if (!first || first.text !== firstMatch) return "最初の強調が最初の一致と違う";
  }
  return "";
}

// 決まった順に乱数を出す（毎回同じキーワードで試すため）
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXED_QUERIES = [
  "権利",
  "設問1",
  "設問１",
  "設 問",
  "権利 濫用",
  "伝聞　例外",
  "第１ 第１",
  "Ａ ａ",
  "論じなさい 存在しない語句ああああ",
  "の 。 、 問",
  "Ａ",
  "x社",
  "(1)",
  "⑴",
  "第１",
  "論じなさい",
  "。",
  "存在しない語句ああああ",
];

{
  const rand = mulberry32(20261013);
  let groups = 0;
  let queries = 0;
  let hitCount = 0;
  const bad = [];
  const badSnippets = [];
  for (const exam of EXAMS) {
    const plainBySubject = new Map(
      exam.subjects.map((s) => [s, loadPlain(exam, s)]),
    );
    for (const group of subjectSearchGroups(exam.subjects)) {
      groups++;
      // 本文から切り出したキーワード（原文のまま・正規化後・段落をまたぐもの）
      const docs = group.subjects.flatMap((s) =>
        [...plainBySubject.get(s).values()].flatMap((d) => Object.values(d)),
      );
      const picked = [];
      for (let k = 0; k < 24 && docs.length; k++) {
        const d = docs[Math.floor(rand() * docs.length)];
        const src = k % 3 === 2 ? d.norm : d.text;
        const at = Math.floor(rand() * src.length);
        picked.push(src.slice(at, at + 1 + Math.floor(rand() * 12)));
      }
      const cases = [...FIXED_QUERIES, ...picked].map((q) => [q, exam.types]);
      // 種類の一部・並べ替えでも同じ順序規則になるか
      cases.push(["の", [...exam.types].reverse().slice(0, 2)]);

      for (const [query, types] of cases) {
        if (!plainTerms(query).length) continue;
        queries++;
        const want = plainSearch(
          exam.yobi,
          plainBySubject,
          group.subjects,
          types,
          query,
        );
        const got = await searchSubject({
          yobi: exam.yobi,
          subjects: group.subjects,
          types,
          query,
        });
        const view = (r) => ({
          hits: r.hits.map((h) => ({
            yearKey: h.yearKey,
            subject: h.subject,
            docType: h.docType,
            counts: h.counts,
          })),
          searchedYears: r.searchedYears,
          missingYears: r.missingYears,
        });
        hitCount += got.hits.length;
        if (
          JSON.stringify(view(got)) !== JSON.stringify(view(want)) ||
          JSON.stringify(got.terms.map((t) => t.norm)) !==
            JSON.stringify(plainTerms(query))
        ) {
          bad.push(`${group.label}「${query}」`);
          continue;
        }
        got.hits.forEach((h, i) => {
          const d = plainBySubject.get(h.subject).get(h.yearKey)[h.docType];
          const why = checkSnippet(
            h.snippet,
            d.text,
            plainTerms(query),
            want.hits[i].matches[0],
          );
          if (why) badSnippets.push(`${group.label}「${query}」${h.yearKey} ${h.docType}: ${why}`);
        });
      }
    }
  }
  for (const b of bad.slice(0, 5)) console.log(`    不一致: ${b}`);
  ok(
    bad.length === 0,
    `検索結果が素朴な照合と一致する（${groups}科目 × 計${queries}語・${hitCount}件）`,
  );
  for (const b of badSnippets.slice(0, 5)) console.log(`    ${b}`);
  ok(badSnippets.length === 0, `抜粋の強調が検索語と一致する（${hitCount}件）`);
}

console.log(ng ? `\n${ng}件 失敗` : "\nすべて成功");
process.exit(ng ? 1 : 0);
