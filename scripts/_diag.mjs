// 一時: PDF.js が返すテキスト項目の座標を覗いて、句読点がどの位置に
// 描かれているかを調べる。この実行環境からは法務省へ直接アクセスできない
// ため GitHub Actions 上で動かしてログを読む。調査後に削除する。
//
// 使い方: node scripts/_diag.mjs <PDFのURL> <ページ番号>
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const dir = createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")
  .replace(/package\.json$/, "");

const [url, pageArg] = process.argv.slice(2);
const page = Number(pageArg || 1);

const res = await fetch(url);
const bytes = new Uint8Array(await res.arrayBuffer());
const doc = await pdfjs.getDocument({
  data: bytes,
  cMapUrl: `${dir}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${dir}standard_fonts/`,
}).promise;
console.log(`${url} 全${doc.numPages}ページ / p${page} を表示`);

const content = await (await doc.getPage(page)).getTextContent();
console.log(`項目数: ${content.items.length}`);
for (const [i, it] of content.items.entries()) {
  if (!("str" in it)) continue;
  const [, , , , x, y] = it.transform;
  console.log(
    `${String(i).padStart(4)} x=${x.toFixed(1).padStart(7)} y=${y.toFixed(1).padStart(7)} w=${(it.width ?? 0).toFixed(1).padStart(6)} eol=${it.hasEOL ? 1 : 0} ${JSON.stringify(it.str)}`,
  );
}
