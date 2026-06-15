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

// 短答式の科目グループ（全年度共通）
export const YOBI_TANTOU_SUBJECTS = [
  "憲法・行政法",
  "民法・商法・民事訴訟法",
  "刑法・刑事訴訟法",
  "一般教養科目",
];

// 論文式の科目グループ。5科目めは令和4年以降「選択科目」、令和3年以前は
// 「一般教養科目」。年度に無い科目を選ぶと探索時に明示エラーになる。
export const YOBI_RONBUN_SUBJECTS = [
  "憲法・行政法",
  "民法・商法・民事訴訟法",
  "刑法・刑事訴訟法",
  "法律実務基礎科目（民事・刑事）",
  "選択科目",
  "一般教養科目",
];

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
