// 一時診断スクリプト（採点実感の取得不良の調査用・調査後に削除する）
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfjs } from "../parser.js";
setPdfjs(pdfjs);

const require = createRequire(import.meta.url);
const CMAP_DIR =
  require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "") +
  "cmaps/";

const { fetchPdf, fetchSaitenPdfUrl } = await import("../moj.js");
const { RESULTS_URL_MAP } = await import("../years.js");

// ── 1. h30 民事系: CMap を渡すとテキストを取り出せるか ────────────────────
{
  const url = await fetchSaitenPdfUrl(RESULTS_URL_MAP.h30, "民事系科目", null);
  console.log(`\n### h30 民事系 採点実感: ${url}`);
  const bytes = await fetchPdf(url);
  for (const opts of [{}, { cMapUrl: CMAP_DIR, cMapPacked: true }]) {
    const doc = await pdfjs.getDocument({ data: bytes.slice(0), ...opts })
      .promise;
    const page = await doc.getPage(1);
    const items = (await page.getTextContent()).items.filter((i) => i.str);
    const text = items
      .map((i) => i.str)
      .join("")
      .slice(0, 120);
    console.log(
      `  cMap=${!!opts.cMapUrl}: pages=${doc.numPages} items=${items.length} | ${text}`,
    );
  }
}

// ── 2. h23 の結果ページ: 採点実感PDFリンクの一覧 ─────────────────────────
{
  const { fetchHtml } = await import("../moj.js");
  const html = await fetchHtml(RESULTS_URL_MAP.h23);
  console.log(`\n### h23 結果ページ: ${RESULTS_URL_MAP.h23}`);
  const links = [...html.matchAll(/href="([^"#]+\.pdf)"[^>]*>([^<]*)</g)];
  for (const [, href, text] of links) {
    console.log(`  ${text.replace(/\s+/g, " ").trim()} -> ${href}`);
  }
  const subs = [
    ...html.matchAll(
      /href="((?:https?:\/\/www\.moj\.go\.jp)?\/jinji[^"]+\.html)"[^>]*>([^<]*)</g,
    ),
  ];
  for (const [, href, text] of subs) {
    const t = text.replace(/\s+/g, " ").trim();
    if (!/採点実感|意見/.test(t)) continue;
    const subUrl = new URL(href, RESULTS_URL_MAP.h23).href;
    console.log(`\n  --- サブページ「${t}」: ${subUrl}`);
    const subHtml = await fetchHtml(subUrl);
    for (const [, h, x] of subHtml.matchAll(
      /href="([^"#]+\.pdf)"[^>]*>([^<]*)</g,
    )) {
      console.log(`    ${x.replace(/\s+/g, " ").trim()} -> ${h}`);
    }
  }
}
