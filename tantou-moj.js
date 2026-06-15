// =============================================================================
// 短答式のリンク探索（DOM非依存・ブラウザ／Node 共通）
//
// 法務省ウェブから短答式の「問題」「正答及び配点」PDF の直URLを特定する。
// 取得そのものは moj.js（Cloudflare Worker 中継）に委譲するため、ブラウザ
// （tantou.js）と Node の巡回・検査スクリプト（scripts/*.mjs）の双方から
// 同じコードパスで利用できる。論文式のリンク探索（moj.js）とは原典ページの
// 構造が異なるため別ファイルに分離している。
//
// 短答式が憲法・民法・刑法の3科目別に出題されるのは平成27年以降。それ以前
// （平成22〜26年）は公法系・民事系・刑事系の系列単位のため対象外。
// =============================================================================
import { fetchHtml } from "./moj.js";

export const TANTOU_SUBJECTS = ["憲法", "民法", "刑法"];
// フッター等に並べる短答式の種類（左から順）
export const TANTOU_DOC_TYPES = ["問題", "正答及び配点"];

// 3科目別出題の年度か（令和は全て / 平成は27年以降）
export function isThreeSubjectYear(key) {
  const n = Number(key.slice(1));
  if (Number.isNaN(n)) return false;
  return key[0] === "r" ? true : n >= 27;
}

function resolveUrl(href, baseUrl) {
  if (/^https?:/.test(href)) return href;
  return new URL(href, baseUrl).toString();
}

// ─── 問題PDF ──────────────────────────────────────────────────────────────
// 試験問題ページの《短答式試験》区分内から、科目名アンカーの PDF を探す。
// 《論文式試験》区分（公法系・民事系…）と混ざらないよう範囲を絞る。
export async function findTantouQuestionPdfUrl(examPageUrl, subject) {
  const html = await fetchHtml(examPageUrl);
  const si = html.indexOf("短答式試験");
  if (si === -1)
    throw new Error("試験問題ページに《短答式試験》の区分が見つかりません。");
  const ei = html.indexOf("論文式試験", si);
  const section = ei === -1 ? html.slice(si) : html.slice(si, ei);

  const m = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>\\s*${subject}\\s*<`).exec(
    section,
  );
  if (!m)
    throw new Error(`短答式「${subject}」の問題PDFリンクが見つかりません。`);
  return resolveUrl(m[1], examPageUrl);
}

// ─── 正答及び配点PDF ──────────────────────────────────────────────────────
// 結果ページ →「短答式試験」サブページ →《正答及び配点》（年度により
// 「正解及び配点」表記）区分内の科目名アンカーをたどる。科目名（憲法・
// 民法・刑法）はこのサブページではこの区分にしか現れない。
export async function findTantouAnswerPdfUrl(resultsPageUrl, subject) {
  const html = await fetchHtml(resultsPageUrl);

  const subM = /href="([^"#]+\.html)"[^>]*>\s*短答式試験\s*</.exec(html);
  if (!subM)
    throw new Error(
      "結果ページに「短答式試験」サブページのリンクが見つかりません。",
    );
  const subUrl = resolveUrl(subM[1], resultsPageUrl);
  const subHtml = await fetchHtml(subUrl);

  let idx = -1;
  for (const kw of ["正答及び配点", "正解及び配点", "正答", "正解"]) {
    idx = subHtml.indexOf(kw);
    if (idx !== -1) break;
  }
  const region = idx === -1 ? subHtml : subHtml.slice(idx);

  const m = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>\\s*${subject}\\s*<`).exec(
    region,
  );
  if (!m)
    throw new Error(
      `短答式「${subject}」の正答・配点PDFリンクが見つかりません。`,
    );
  return resolveUrl(m[1], subUrl);
}

// 問題・正答の原典PDF直URLをまとめて解決する（フッターのリンク表示用）。
// 取得できない種類は null。
export async function resolveTantouSourceUrls(
  examPageUrl,
  resultsPageUrl,
  subject,
) {
  const urls = { 問題: null, 正答及び配点: null };
  try {
    urls["問題"] = await findTantouQuestionPdfUrl(examPageUrl, subject);
  } catch {
    /* 未掲載・取得失敗は null のまま */
  }
  if (resultsPageUrl) {
    try {
      urls["正答及び配点"] = await findTantouAnswerPdfUrl(
        resultsPageUrl,
        subject,
      );
    } catch {
      /* noop */
    }
  }
  return urls;
}
