// =============================================================================
// 短答式の問題PDF → 検索用テキスト（DOM非依存・Node の事前変換で使う）
//
// 短答式は選択式で図表や選択肢の配置が多く、読み物としてのテキスト化には
// 向かないため、画面にテキストは出さない。全文検索の対象にするためだけに、
// 問題PDFの本文をブロック（≒段落）単位の文字列の並びとして取り出す。
//
//   司法試験: 科目ごとの問題PDF。表紙など設問の無い先頭ページを除く。
//   予備試験: 科目グループのまとめPDF（憲法・行政法 など）から当該科目の
//             ページだけを切り出す（区切りを特定できない年度は作らない）。
//
// scripts/precompute.mjs が converted/tantou/<試験>/<年度>/<科目>.json に
// { 問題: { paras, pdfUrl } } として書き出し、build-search-index.mjs が
// 全文検索の索引（converted/search/tantou-<試験>/）を作る。
// =============================================================================
import { YEAR_URL_MAP } from "./years.js";
import { YOBI_YEAR_URL_MAP } from "./yobi-years.js";
export { tantouYearKeys, tantouSubjects } from "./tantou-moj.js";
import { fetchPdf } from "./moj.js";
import { extractBoxes } from "./parser.js";
import { firstContentPage, findSubjectPageRange } from "./pdfsplit.js";
import { findTantouQuestionPdfUrl } from "./tantou-moj.js";
import {
  YOBI_TANTOU_DEF,
  YOBI_ALL_HEADERS,
  yobiSubjectCandidates,
} from "./yobi-moj.js";

// 1年度×1科目の問題PDFを取得し、該当ページの本文を段落の並びにする。
export async function buildTantouEntry({ yobi, yearKey, subject }) {
  const pageUrl = (yobi ? YOBI_YEAR_URL_MAP : YEAR_URL_MAP)[yearKey];
  if (!pageUrl) throw new Error(`未対応の年度: ${yearKey}`);
  const def = yobi ? YOBI_TANTOU_DEF[subject] : null;
  if (yobi && !def) throw new Error(`未対応の科目: ${subject}`);

  const pdfUrl = await findTantouQuestionPdfUrl(
    pageUrl,
    yobi ? yobiSubjectCandidates(def.group) : subject,
  );
  const pdfBytes = await fetchPdf(pdfUrl);

  // ページ範囲（1始まり・両端含む）。PDF.js は渡したバッファを移譲するので
  // 判定ごとにコピーを渡す。
  let range;
  if (def && def.qHeaders) {
    range = await findSubjectPageRange(
      pdfBytes.slice(0),
      def.qHeaders,
      YOBI_ALL_HEADERS,
    );
    if (!range)
      throw new Error(`「${subject}」の区切りをPDF上で特定できません`);
  } else {
    range = [await firstContentPage(pdfBytes.slice(0)), Number.MAX_SAFE_INTEGER];
  }

  const boxes = await extractBoxes(pdfBytes.slice(0));
  const paras = boxes
    .filter((b) => b.page >= range[0] && b.page <= range[1])
    .map((b) => b.text.trim())
    .filter(Boolean);
  if (!paras.length)
    throw new Error("本文の文字を取り出せませんでした（画像PDF等の可能性）");
  return { paras, pdfUrl };
}
