// 一時診断スクリプト（選択科目の取りこぼし調査用・調査後に削除する）
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs, extractBoxes } from "../parser.js";
setPdfjs(pdfjs);

const { isSaitenTitle, normSubject } = await import("../rules.js");
const { fetchExamPdfUrl, fetchSaitenPdfUrl, fetchPdf } = await import(
  "../moj.js"
);
const { YEAR_URL_MAP, RESULTS_URL_MAP } = await import("../years.js");

const short = (t) => t.replace(/\s+/g, " ").slice(0, 60);

// ── 1. r8 選択科目の試験問題: 〔第１問〕〔第２問〕マーカーの並び ──────────
{
  const url = await fetchExamPdfUrl(YEAR_URL_MAP.r8, "選択科目");
  console.log(`\n### r8 選択科目 試験問題: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  console.log(`boxes=${boxes.length}`);
  boxes.forEach((b, i) => {
    const t = b.text;
    if (
      /〔第|問〕|論文式試験問題集/.test(t) ||
      /知的財産法|労働法|環境法|租税法/.test(t)
    ) {
      console.log(`  [${i}] p${b.page} ${short(t)}`);
    }
  });
}

// ── 2. r6 採点実感（国際関係法）: タイトル行の実際の表記 ─────────────────
for (const kw of ["国際関係法（公法系）", "国際関係法（私法系）"]) {
  const url = await fetchSaitenPdfUrl(RESULTS_URL_MAP.r6, "選択科目", kw);
  console.log(`\n### r6 採点実感 ${kw}: ${url}`);
  const boxes = await extractBoxes(await fetchPdf(url));
  console.log(`boxes=${boxes.length}`);
  boxes.forEach((b, i) => {
    if (isSaitenTitle(b.text) || /国際関係|採点実感/.test(b.text)) {
      console.log(
        `  [${i}] p${b.page} title=${isSaitenTitle(b.text)} ${short(b.text)} | norm=${short(normSubject(b.text))}`,
      );
    }
  });
}
