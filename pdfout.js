// =============================================================================
// 原典PDF出力（該当ページの抜き出しとスタンプ印字）
//
// pdf-lib で原典PDFから該当ページだけをコピーし、各ページのフッターに
// ファイル名（右）と出典・加工表示（左）を印字する。zip 生成用の fflate
// ローダーもここに置く。
// =============================================================================
import { sourceLine } from "./format.js";

let _pdfLibPromise = null;
async function loadPdfLib() {
  if (!_pdfLibPromise)
    _pdfLibPromise = import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
  return _pdfLibPromise;
}

let _fflatePromise = null;
export async function loadFflate() {
  if (!_fflatePromise)
    _fflatePromise = import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm");
  return _fflatePromise;
}

// ファイル名をフッター用の透過 PNG として描画する（PDF への日本語テキスト
// 埋め込みは日本語フォントの同梱が必要になるため、Canvas 描画で代替する）
function makeTextStampPng(text) {
  const fontPx = 48;
  const font = `${fontPx}px -apple-system, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 8;
  canvas.height = Math.ceil(fontPx * 1.4);
  ctx = canvas.getContext("2d"); // サイズ変更で状態が初期化されるため再設定
  ctx.font = font;
  ctx.fillStyle = "#555555";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 4, canvas.height / 2);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    aspect: canvas.width / canvas.height,
  };
}

// 原典PDFから該当ページを抜き出し、出典・ファイル名スタンプを付けた
// PDF バイト列を生成する
export async function buildStampedPdf(pdfBytes, pageRange, baseName, pdfUrl) {
  const { PDFDocument } = await loadPdfLib();
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const total = src.getPageCount();

  let out;
  let rangeLabel = `全${total}ページ`;
  if (pageRange) {
    const start = Math.max(1, pageRange[0]);
    const end = Math.min(total, pageRange[1]);
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p - 1);
    out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    for (const pg of pages) out.addPage(pg);
    rangeLabel =
      start === end ? `${start}ページのみ` : `${start}〜${end}ページ`;
  } else {
    out = src;
  }

  // 各ページのフッターにファイル名（右）と出典・加工表示（左）を記載
  const stamp = makeTextStampPng(baseName);
  const stampImg = await out.embedPng(stamp.dataUrl);
  const stampH = 9; // pt
  const stampW = stampH * stamp.aspect;
  const srcStamp = makeTextStampPng(sourceLine(pdfUrl));
  const srcImg = await out.embedPng(srcStamp.dataUrl);
  const srcH = 7; // pt
  const srcW = srcH * srcStamp.aspect;
  for (const page of out.getPages()) {
    page.drawImage(stampImg, {
      x: page.getWidth() - stampW - 28,
      y: 16,
      width: stampW,
      height: stampH,
      opacity: 0.85,
    });
    page.drawImage(srcImg, {
      x: 28,
      y: 17,
      width: srcW,
      height: srcH,
      opacity: 0.85,
    });
  }

  return { bytes: await out.save(), rangeLabel, total };
}
