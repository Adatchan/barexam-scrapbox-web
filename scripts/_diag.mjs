// 一時診断（h22 民訴と、予備の趣旨マーカー表記の調査用・調査後に削除する）
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

const { fetchPdf, fetchExamPdfUrl, fetchShushiPdfUrl } = await import(
  "../moj.js"
);
const { YEAR_URL_MAP, RESULTS_URL_MAP } = await import("../years.js");
const { findYobiShushiPdfUrl } = await import("../yobi-moj.js");
const { YOBI_RESULTS_URL_MAP } = await import("../yobi-years.js");

const short = (t) => t.replace(/\s+/g, " ").slice(0, 70);

// ── A. 平成22年 司法 民事系（民訴＝第３問）──────────────────────────────
{
  const url = await fetchExamPdfUrl(YEAR_URL_MAP.h22, "民事系科目");
  console.log(`\n### h22 民事系 試験問題: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  console.log(`boxes=${boxes.length}`);
  boxes.forEach((b, i) => {
    if (/〔第|問〕|論文式試験問題集|民事系/.test(b.text))
      console.log(`  [${i}] p${b.page} ${short(b.text)}`);
  });
}
{
  const url = await fetchShushiPdfUrl(RESULTS_URL_MAP.h22, null);
  console.log(`\n### h22 出題の趣旨: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  console.log(`boxes=${boxes.length}`);
  boxes.forEach((b, i) => {
    if (/【|〔第|系科目/.test(b.text))
      console.log(`  [${i}] p${b.page} ${short(b.text)}`);
  });
}

// ── B. 予備の趣旨マーカー（年度による表記揺れ）──────────────────────────
for (const year of ["h23", "h25", "r7"]) {
  const url = await findYobiShushiPdfUrl(YOBI_RESULTS_URL_MAP[year]);
  console.log(`\n### ${year} 予備 趣旨マーカー: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  const hits = boxes.filter((b) => /出題.{0,3}趣旨/.test(b.text));
  console.log(`boxes=${boxes.length} 趣旨語を含むボックス=${hits.length}`);
  hits.slice(0, 12).forEach((b) => console.log(`  p${b.page} ${short(b.text)}`));
}
