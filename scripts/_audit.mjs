// 一時: 事前変換データ（converted/**.json）の改行・段落エラー監査
//
// 「公用文作成の考え方」（文化審議会建議）Ⅰ-5・6 を判定基準にする。
//   ・項目の細別と階層（横書き）: 第１ → １ → （１） → ア → （ア）
//   ・文の書き出し・改行直後は１字下げ
//   ・句点は「。」、読点は「、」（横書きは「，」も可だが文書内で統一）
//
// 使い方: node scripts/_audit.mjs [対象パス接頭辞...]   例: node scripts/_audit.mjs converted/r7
//         node scripts/_audit.mjs --json out.json  で全件の詳細をJSON出力
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "converted";

// 階層見出しトークン（行頭に来るべきもの）
const NUM_TOKEN =
  "(?:第[０-９0-9一二三四五六七八九十]{1,3}[　 ]|[０-９]{1,2}[　 ]|[(（][０-９0-9]{1,2}[)）]|[ア-ン][　 ]|[(（][ア-ン][)）]|〔[^〕]{1,12}〕|【[^】]{1,20}】)";

const CHECKS = {
  // 改行されず前の文にぶら下がった階層見出し（「。」の直後に見出しが続く）
  見出しの埋没: (t) => new RegExp(`。${NUM_TOKEN}`, "g"),
  // ページ番号・柱の混入。前後が仮名・漢字のときだけ（「法人税基本通達
  // ２−２−１２」のような条項番号を誤検知しないよう rules.js と同じ条件）
  ページ番号混入: () =>
    /(?<=[ぁ-んァ-ヶ一-龥])[-‐‑‒–—―−ー]\s*[0-9０-９]{1,3}\s*[-‐‑‒–—―−ー](?=[ぁ-んァ-ヶ一-龥])/g,
  柱の混入: () => /論文式試験問題集|司法試験予備試験論文式試験問題と出題趣旨/g,
  // 空白の残骸（全角スペース2つ以上、半角スペース2つ以上）
  連続空白: () => /[ ]{2,}|　{2,}/g,
};

// 文末として自然な終わり方
const END_OK = /[。」』）\)］\]〕】：:；;、,]$/;
// 文の続きに見える書き出し（助詞・接続助詞・小書き仮名など）
const CONT_HEAD = /^[をにはがのでともやへかなど、。」』）\)〕】ぁ-んー]/;

function analyzeEntry(paras) {
  const issues = [];
  const text = paras.join("\n");

  for (const [name, mk] of Object.entries(CHECKS)) {
    const re = mk(text);
    let m;
    while ((m = re.exec(text))) {
      issues.push({ type: name, at: m.index, sample: snippet(text, m.index) });
      if (issues.length > 400) break;
    }
  }

  // 段落が文の途中で切れている（段落末が句点等でなく、次段落が助詞等で始まる）
  for (let i = 0; i < paras.length - 1; i++) {
    const a = paras[i].trim();
    const b = paras[i + 1].trim();
    if (a.length < 15) continue; // 見出し・扉行は対象外
    if (END_OK.test(a)) continue;
    if (!CONT_HEAD.test(b)) continue;
    issues.push({
      type: "文の途中で段落が分断",
      at: -1,
      sample: `…${a.slice(-24)} ／ ${b.slice(0, 24)}…`,
    });
  }

  // 同一段落の連続（重複出力）
  for (let i = 0; i < paras.length - 1; i++) {
    if (paras[i].length > 30 && paras[i] === paras[i + 1]) {
      issues.push({
        type: "段落の重複",
        at: -1,
        sample: paras[i].slice(0, 40),
      });
    }
  }

  // ルビ・注記の断片（短いひらがなだけの段落）
  for (const p of paras) {
    const t = p.trim();
    if (t.length > 0 && t.length <= 8 && /^[ぁ-んー]+$/.test(t))
      issues.push({ type: "ルビ断片", at: -1, sample: t });
  }

  // 読点の混在（「，」と「、」が同居）
  const comma = (text.match(/，/g) || []).length;
  const ten = (text.match(/、/g) || []).length;
  if (comma > 0 && ten > 0)
    issues.push({
      type: "読点の混在",
      at: -1,
      sample: `，${comma}個 / 、${ten}個`,
    });

  return issues;
}

function snippet(text, at) {
  return text.slice(Math.max(0, at - 18), at + 26).replace(/\n/g, "⏎");
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith(".json")) yield p;
  }
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const prefixes = args.filter((a, i) => !a.startsWith("--") && i !== jsonAt + 1);

const summary = new Map(); // type -> {files:Set, count:number, samples:[]}
const perFile = [];
const all = []; // 別科目の取り込み検査用

for (const file of walk(ROOT)) {
  if (prefixes.length && !prefixes.some((p) => file.startsWith(p))) continue;
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const [docType, entry] of Object.entries(data)) {
    if (!entry || !Array.isArray(entry.paras)) continue;
    const text = entry.paras.join("\n");
    all.push({
      key: `${file.slice(0, file.lastIndexOf("/"))}[${docType}]`,
      sub: file.slice(file.lastIndexOf("/") + 1, -5),
      text,
      n: text.length,
    });
    const issues = analyzeEntry(entry.paras);
    if (!issues.length) continue;
    perFile.push({ file, docType, issues });
    for (const is of issues) {
      const s = summary.get(is.type) || { files: new Set(), count: 0, samples: [] };
      s.files.add(`${file}[${docType}]`);
      s.count++;
      if (s.samples.length < 6) s.samples.push(`${file}[${docType}] ${is.sample}`);
      summary.set(is.type, s);
    }
  }
}

// 同じ年度・種類の別科目の内容をそのまま含んでいないか（合冊PDFの
// 区切り判定に失敗すると、後続の科目まで丸ごと取り込んでしまう）
const overCapture = [];
const byKey = new Map();
for (const e of all) {
  if (!byKey.has(e.key)) byKey.set(e.key, []);
  byKey.get(e.key).push(e);
}
for (const [key, list] of byKey) {
  for (const a of list) {
    for (const b of list) {
      if (a === b || b.n < 200 || a.n <= b.n * 1.5) continue;
      if (!a.text.includes(b.text.slice(-160))) continue;
      overCapture.push(`${key} ${a.sub}(${a.n}字) が ${b.sub}(${b.n}字) を含む`);
      break;
    }
  }
}

console.log(`対象: ${prefixes.length ? prefixes.join(", ") : "全件"}`);
if (overCapture.length) {
  console.log(`\n■ 別科目の取り込み: ${overCapture.length}件`);
  for (const line of overCapture) console.log(`   ${line}`);
}
console.log(`問題のあるエントリ: ${perFile.length}`);
for (const [type, s] of [...summary].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n■ ${type}: ${s.count}件 / ${s.files.size}エントリ`);
  for (const ex of s.samples) console.log(`   ${ex}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(perFile, null, 1));
  console.log(`\n詳細を書き出し: ${jsonOut}`);
}
