// 全文検索の回帰テスト（外部依存なしで動く）
//
//   ・索引（converted/search/）が、事前変換データ（converted/）から作り直した
//     ものと一致する（converted/ を直して索引を作り直し忘れた、を検出する）。
//   ・索引の正規化済みテキストと位置の対応表が、原文をその場で正規化した結果と
//     全文字で一致する。
//   ・索引を使った検索（search.js）が、本文をその場で正規化して照合する素朴な
//     方法と同じ年度・種類・件数・一致箇所を返す。キーワードは固定の例と、本文
//     から決まった手順で切り出した部分文字列を使う。
//
// 使い方: node scripts/test-search.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSearchDoc,
  normalizeQuery,
  normalizeWithMap,
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

// 本文を毎回そのまま照合する素朴な検索（索引を使う前の方式と同じ規則）
function plainSearch(yobi, plainBySubject, subjects, types, query) {
  const q = normalizeQuery(query);
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
        let count = 0;
        let match = "";
        for (let from = 0; ; ) {
          const i = d.norm.indexOf(q, from);
          if (i === -1) break;
          if (!count)
            match = d.text.slice(d.map[i], d.map[i + q.length - 1] + 1);
          count++;
          from = i + q.length;
        }
        if (count) hits.push({ yearKey, subject, docType, count, match });
      }
    }
  }
  return { hits, searchedYears: searched.size, missingYears: [...missing] };
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
        if (!normalizeQuery(query)) continue;
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
        const gotView = {
          hits: got.hits.map((h) => ({
            yearKey: h.yearKey,
            subject: h.subject,
            docType: h.docType,
            count: h.count,
            match: h.snippet.match,
          })),
          searchedYears: got.searchedYears,
          missingYears: got.missingYears,
        };
        hitCount += got.hits.length;
        if (JSON.stringify(gotView) !== JSON.stringify(want))
          bad.push(`${group.label}「${query}」`);
      }
    }
  }
  for (const b of bad.slice(0, 5)) console.log(`    不一致: ${b}`);
  ok(
    bad.length === 0,
    `検索結果が素朴な照合と一致する（${groups}科目 × 計${queries}語・${hitCount}件）`,
  );
}

console.log(ng ? `\n${ng}件 失敗` : "\nすべて成功");
process.exit(ng ? 1 : 0);
