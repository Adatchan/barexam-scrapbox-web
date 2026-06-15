// =============================================================================
// 司法試験予備試験のリンク探索・科目定義（DOM非依存・ブラウザ／Node 共通）
//
// 予備試験は科目グループ別（憲法・行政法 など）にPDFが公表される。短答式の
// 問題・正解及び配点は司法試験の短答式とページ構造が同じため、探索は
// tantou-moj.js の関数をそのまま流用する（URLと科目名だけ予備のものを渡す）。
// 論文式の問題（論文式試験の区分）と、全科目をまとめた出題の趣旨（結果ページ
// 掲載の1PDF）は予備固有のため、ここで探索する。採点実感は予備には無い。
// =============================================================================
import { fetchHtml } from "./moj.js";
import { reEscape } from "./rules.js";

// 予備試験は科目をまとめたPDF（憲法・行政法 など）で公表されるため、個別
// 科目で切り出すには「どのグループPDFに入っていて、PDF内のどの角括弧見出し
// （［憲法］等）で始まるか」を持つ。group=取得するグループPDF（科目名で探索）、
// qHeaders=問題PDF内の見出し（null=分割せず単独PDF全体）、sHeaders=出題の
// 趣旨PDF（全科目まとめた1ファイル）内の見出し（null=趣旨なし）。
const SENTAKU_HEADERS = [
  "倒産法",
  "租税法",
  "経済法",
  "知的財産法",
  "労働法",
  "環境法",
  "国際関係法（公法系）",
  "国際関係法（私法系）",
];

// 境界判定（次の科目の開始＝対象科目の終端）に使う全見出し
export const YOBI_ALL_HEADERS = [
  "憲法",
  "行政法",
  "民法",
  "商法",
  "民事訴訟法",
  "刑法",
  "刑事訴訟法",
  "一般教養科目",
  "民事",
  "刑事",
  "法律実務基礎科目（民事）",
  "法律実務基礎科目（刑事）",
  ...SENTAKU_HEADERS,
];

// 短答式: 個別科目 → { group, qHeaders }。正答及び配点は1ページの表のため
// 分割せずグループPDF全体を出す。
export const YOBI_TANTOU_DEF = {
  憲法: { group: "憲法・行政法", qHeaders: ["憲法"] },
  行政法: { group: "憲法・行政法", qHeaders: ["行政法"] },
  民法: { group: "民法・商法・民事訴訟法", qHeaders: ["民法"] },
  商法: { group: "民法・商法・民事訴訟法", qHeaders: ["商法"] },
  民事訴訟法: { group: "民法・商法・民事訴訟法", qHeaders: ["民事訴訟法"] },
  刑法: { group: "刑法・刑事訴訟法", qHeaders: ["刑法"] },
  刑事訴訟法: { group: "刑法・刑事訴訟法", qHeaders: ["刑事訴訟法"] },
  一般教養科目: { group: "一般教養科目", qHeaders: null }, // 単独PDF
};

// 論文式: 個別科目 → { group, qHeaders, sHeaders }。
export const YOBI_RONBUN_DEF = {
  憲法: { group: "憲法・行政法", qHeaders: ["憲法"], sHeaders: ["憲法"] },
  行政法: { group: "憲法・行政法", qHeaders: ["行政法"], sHeaders: ["行政法"] },
  民法: {
    group: "民法・商法・民事訴訟法",
    qHeaders: ["民法"],
    sHeaders: ["民法"],
  },
  商法: {
    group: "民法・商法・民事訴訟法",
    qHeaders: ["商法"],
    sHeaders: ["商法"],
  },
  民事訴訟法: {
    group: "民法・商法・民事訴訟法",
    qHeaders: ["民事訴訟法"],
    sHeaders: ["民事訴訟法"],
  },
  刑法: { group: "刑法・刑事訴訟法", qHeaders: ["刑法"], sHeaders: ["刑法"] },
  刑事訴訟法: {
    group: "刑法・刑事訴訟法",
    qHeaders: ["刑事訴訟法"],
    sHeaders: ["刑事訴訟法"],
  },
  "法律実務基礎科目（民事）": {
    group: "法律実務基礎科目（民事・刑事）",
    qHeaders: ["民事"],
    // 趣旨の見出しは年度により「法律実務基礎科目（民事）」と「民事」の揺れあり
    sHeaders: ["法律実務基礎科目（民事）", "民事"],
  },
  "法律実務基礎科目（刑事）": {
    group: "法律実務基礎科目（民事・刑事）",
    qHeaders: ["刑事"],
    sHeaders: ["法律実務基礎科目（刑事）", "刑事"],
  },
  // 選択科目は問題が選択科目をまとめた単独PDF（分割せず全体）、趣旨は
  // 全科目まとめたPDFの選択科目ブロック全体を切り出す。
  選択科目: { group: "選択科目", qHeaders: null, sHeaders: SENTAKU_HEADERS },
  // 一般教養科目（令和3年以前）。問題は単独PDF、趣旨は無い。
  一般教養科目: { group: "一般教養科目", qHeaders: null, sHeaders: null },
};

// プルダウン用の個別科目名一覧（DEFの定義順）
export const YOBI_TANTOU_SUBJECTS = Object.keys(YOBI_TANTOU_DEF);
export const YOBI_RONBUN_SUBJECTS = Object.keys(YOBI_RONBUN_DEF);

function resolveUrl(href, baseUrl) {
  if (/^https?:/.test(href)) return href;
  return new URL(href, baseUrl).toString();
}

// 科目名の表記揺れに対応する別名候補を返す（長い順）。「一般教養科目」は
// 年度・種類により「一般教養」と表記されることがある（例: 令和元年の正解
// 及び配点）。短答・論文どちらの探索にも渡せる。
export function yobiSubjectCandidates(subject) {
  if (subject === "一般教養科目") return ["一般教養科目", "一般教養"];
  return [subject];
}

// 論文式の問題PDF。試験問題ページの《論文式試験》区分（短答式の後ろ）から
// 科目名アンカーの PDF を探す。subject は単一文字列でも別名配列でも可。
export async function findYobiRonbunPdfUrl(examPageUrl, subject) {
  const html = await fetchHtml(examPageUrl);
  const li = html.indexOf("論文式試験");
  if (li === -1)
    throw new Error("試験問題ページに《論文式試験》の区分が見つかりません。");
  const section = html.slice(li);
  const cands = Array.isArray(subject) ? subject : [subject];
  const alt = cands.map(reEscape).join("|");
  const m = new RegExp(
    `href="([^"#]+\\.pdf)"[^>]*>\\s*(?:${alt})\\s*<`,
  ).exec(section);
  if (!m)
    throw new Error(
      `予備試験 論文式「${cands.join("／")}」の問題PDFが見つかりません（その年度には無い科目の可能性があります）。`,
    );
  return resolveUrl(m[1], examPageUrl);
}

// 論文式の出題の趣旨PDF（全科目をまとめた1ファイル）。結果ページ掲載の
// 「論文式試験出題の趣旨」アンカーを探す。
export async function findYobiShushiPdfUrl(resultsPageUrl) {
  const html = await fetchHtml(resultsPageUrl);
  const patterns = [
    /href="([^"#]+\.pdf)"[^>]*>[^<]*論文[^<]*出題の趣旨/,
    /href="([^"#]+\.pdf)"[^>]*>[^<]*出題の趣旨/,
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (m) return resolveUrl(m[1], resultsPageUrl);
  }
  throw new Error("予備試験 論文式試験の出題の趣旨PDFが見つかりません。");
}
