// 一時診断スクリプト（修正の実データ検証用・検証後に削除する）
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { setPdfjs, setPdfDocOptions } from "../parser.js";
setPdfjs(pdfjs);
const pdfjsDir = createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")
  .replace(/package\.json$/, "");
setPdfDocOptions({
  cMapUrl: `${pdfjsDir}cmaps/`,
  standardFontDataUrl: `${pdfjsDir}standard_fonts/`,
});

const { buildEntry } = await import("../convert.js");
const silent = { log: () => {}, setProgress: () => {} };

// 1. ブラウザ用 CDN（jsDelivr）に CMap・標準フォントが実在するか
for (const path of [
  "cmaps/Adobe-Japan1-UCS2.bcmap",
  "cmaps/UniJIS-UCS2-H.bcmap",
  "standard_fonts/FoxitSerif.pfb",
]) {
  const url = `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/${path}`;
  const res = await fetch(url, { method: "GET" });
  console.log(`CDN ${res.status} ${path}`);
}

// 2. 修正対象の変換
const cases = [
  ["h23", "憲法", "採点実感"],
  ["h23", "行政法", "採点実感"],
  ["h30", "民法", "採点実感"],
  ["h30", "商法", "採点実感"],
  ["h30", "民訴", "採点実感"],
  ["h23", "民法", "採点実感"], // 既存OK（退行していないか）
  ["r7", "憲法", "試験問題"], // 既存OK
  ["r6", "労働法第１問", "採点実感"], // 既存OK
];
for (const [y, s, t] of cases) {
  try {
    const e = await buildEntry({ yearKey: y, subject: s, docType: t }, silent);
    const head = (e.paras[0] || "").replace(/\s+/g, " ").slice(0, 50);
    const chars = e.paras.join("").length;
    console.log(
      `OK  ${y} ${s} ${t} | ${e.paras.length}段落 ${chars}字 ${e.pdfUrl.split("/").pop()} | ${head}`,
    );
  } catch (err) {
    console.log(`NG  ${y} ${s} ${t} | ${err.message}`);
  }
}
