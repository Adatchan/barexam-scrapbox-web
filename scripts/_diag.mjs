// 一時診断スクリプト（採点実感のタイトル判定の調査用・調査後に削除する）
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs, extractBoxes } from "../parser.js";
setPdfjs(pdfjs);

const { isSaitenTitle } = await import("../rules.js");
const { fetchSaitenPdfUrl, fetchPdf } = await import("../moj.js");
const { RESULTS_URL_MAP } = await import("../years.js");

const short = (t) => t.replace(/\s+/g, " ").slice(0, 90);

for (const [year, system] of [
  ["h23", "公法系科目"],
  ["h30", "民事系科目"],
]) {
  const url = await fetchSaitenPdfUrl(RESULTS_URL_MAP[year], system, null);
  console.log(`\n### ${year} ${system} 採点実感: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  console.log(`boxes=${boxes.length}`);
  boxes.forEach((b, i) => {
    if (/採点実感|意見|系科目|第[１２３]問/.test(b.text)) {
      const t = b.text;
      console.log(
        `  [${i}] p${b.page} title=${isSaitenTitle(t)} len=${t.length} ${short(t)}`,
      );
    }
  });
}
