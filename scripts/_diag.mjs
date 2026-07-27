// 一時診断スクリプト（予備の法律実務基礎科目の趣旨見出し調査用・調査後に削除）
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { setPdfjs, setPdfDocOptions, extractBoxes } from "../parser.js";
setPdfjs(pdfjs);
const dir = createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")
  .replace(/package\.json$/, "");
setPdfDocOptions({
  cMapUrl: `${dir}cmaps/`,
  standardFontDataUrl: `${dir}standard_fonts/`,
});

const { fetchPdf } = await import("../moj.js");
const { findYobiShushiPdfUrl } = await import("../yobi-moj.js");
const { YOBI_RESULTS_URL_MAP } = await import("../yobi-years.js");

const short = (t) => t.replace(/\s+/g, " ").slice(0, 80);

for (const year of ["h23", "h28"]) {
  const url = await findYobiShushiPdfUrl(YOBI_RESULTS_URL_MAP[year]);
  console.log(`\n### ${year} 予備 出題の趣旨: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  console.log(`boxes=${boxes.length} 総文字数=${boxes.reduce((a, b) => a + b.text.length, 0)}`);
  // 角括弧見出しらしきものと、実務基礎に関わる語を含むボックスを列挙
  boxes.forEach((b, i) => {
    const t = b.text;
    if (/[[［]|実務基礎|民事|刑事/.test(t)) {
      console.log(`  [${i}] p${b.page} ${short(t)}`);
    }
  });
}
