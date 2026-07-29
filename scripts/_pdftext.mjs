import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const dir = createRequire(import.meta.url).resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");
const doc = await pdfjs.getDocument({
  url: process.argv[2],
  cMapUrl: `${dir}cmaps/`, cMapPacked: true, standardFontDataUrl: `${dir}standard_fonts/`,
}).promise;
let out = "";
for (let i = 1; i <= doc.numPages; i++) {
  const c = await (await doc.getPage(i)).getTextContent();
  out += `\n===== p${i} =====\n` + c.items.map((x) => x.str + (x.hasEOL ? "\n" : "")).join("");
}
writeFileSync(process.argv[3], out);
console.log("pages:", doc.numPages, "chars:", out.length);
