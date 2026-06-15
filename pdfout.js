// =============================================================================
// 原典PDF出力（該当ページの抜き出しとスタンプ印字）
//
// pdf-lib で原典PDFから該当ページだけをコピーし、各ページのフッターに
// ファイル名（右）と出典・加工表示（左）を印字する。zip 生成用の fflate
// ローダーもここに置く。
// =============================================================================
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

// テキストをフッター用の透過 PNG として描画する（PDF への日本語テキスト
// 埋め込みは日本語フォントの同梱が必要になるため、Canvas 描画で代替する）。
// underline=true でリンク風の下線を付ける。
function makeTextStampPng(text, color = "#555555", underline = false) {
  const fontPx = 48;
  const font = `${fontPx}px -apple-system, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  ctx.font = font;
  const textW = Math.ceil(ctx.measureText(text).width);
  canvas.width = textW + 8;
  canvas.height = Math.ceil(fontPx * 1.4);
  ctx = canvas.getContext("2d"); // サイズ変更で状態が初期化されるため再設定
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 4, canvas.height / 2);
  if (underline) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, fontPx / 18);
    const uy = canvas.height / 2 + fontPx * 0.42;
    ctx.beginPath();
    ctx.moveTo(4, uy);
    ctx.lineTo(4 + textW, uy);
    ctx.stroke();
  }
  return {
    dataUrl: canvas.toDataURL("image/png"),
    aspect: canvas.width / canvas.height,
  };
}

// 各ページのフッターに、ファイル名（右）と出典＋原典PDF直リンク群
// （左）を印字する。リンク部分には URI 注釈を付与してクリック可能にする。
// docTypes は左下に並べる種類の見出し（論文式は試験問題・出題の趣旨・採点実感、
// 短答式は問題・正答及び配点）。sourceUrls は各見出し→URL（無い種類は null）。
async function drawFooter(
  out,
  PDFString,
  baseName,
  sourceUrls,
  docTypes = ["試験問題", "出題の趣旨", "採点実感"],
) {
  // 右下: ファイル名
  const nameStamp = makeTextStampPng(baseName);
  const nameImg = await out.embedPng(nameStamp.dataUrl);
  const nameH = 9; // pt
  const nameW = nameH * nameStamp.aspect;

  // 左下: 「出典：法務省ウェブサイト（原典を加工）」＋ ［種類］リンク群
  const segH = 7; // pt
  const segs = [
    { ...makeTextStampPng("出典：法務省ウェブサイト（原典を加工）　"), url: null },
  ];
  for (const docType of docTypes) {
    const url = sourceUrls?.[docType] || null;
    const color = url ? "#1a4f8a" : "#aaaaaa";
    segs.push({ ...makeTextStampPng(`［${docType}］`, color, !!url), url });
  }
  for (const s of segs) s.img = await out.embedPng(s.dataUrl);

  for (const page of out.getPages()) {
    page.drawImage(nameImg, {
      x: page.getWidth() - nameW - 28,
      y: 16,
      width: nameW,
      height: nameH,
      opacity: 0.85,
    });

    let x = 28;
    const y = 16;
    for (const s of segs) {
      const w = segH * s.aspect;
      page.drawImage(s.img, { x, y, width: w, height: segH, opacity: 0.9 });
      if (s.url) {
        const annot = out.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [x, y - 1, x + w, y + segH + 1],
          Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of(s.url) },
        });
        page.node.addAnnot(out.context.register(annot));
      }
      x += w;
    }
  }
}

// 各ページの左上の余白に、見出しラベル（年度・科目・種類）を約20ポイントで
// 印字する。本文は上端から十分下にあるため、上端の余白帯に収めて本文と
// 重ならないようにする（日本語は Canvas 描画 PNG で埋め込む）。
async function drawTopLabel(out, text) {
  const stamp = makeTextStampPng(text, "#004679");
  const img = await out.embedPng(stamp.dataUrl);
  const h = 20; // pt（約20ポイント）
  const w = h * stamp.aspect;
  for (const page of out.getPages()) {
    page.drawImage(img, {
      x: 28,
      y: page.getHeight() - 18 - h, // 上端から 18pt 下げた余白帯に配置
      width: w,
      height: h,
      opacity: 0.92,
    });
  }
}

// 原典PDFから該当ページを抜き出し、フッターにファイル名と出典リンクを
// 付けた PDF バイト列を生成する。
// sourceUrls = フッターに並べる種類→URL（各 URL か null）
// docTypes = フッターに並べる種類の見出し（省略時は論文式の3種類）
// topLabel = 指定すると各ページ左上に約20ptの見出しスタンプを印字する
export async function buildStampedPdf(
  pdfBytes,
  pageRange,
  baseName,
  sourceUrls,
  docTypes,
  topLabel,
) {
  const { PDFDocument, PDFString } = await loadPdfLib();
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const total = src.getPageCount();

  let out;
  let rangeLabel = `全${total}ページ`;
  if (pageRange) {
    const start = Math.max(1, pageRange[0]);
    const end = Math.min(total, pageRange[1]);
    if (start <= end) {
      const indices = [];
      for (let p = start; p <= end; p++) indices.push(p - 1);
      out = await PDFDocument.create();
      const pages = await out.copyPages(src, indices);
      for (const pg of pages) out.addPage(pg);
      rangeLabel =
        start === end ? `${start}ページのみ` : `${start}〜${end}ページ`;
    }
  }
  // pageRange 未指定、または範囲が空（例: 1ページしかないのに2ページ目以降を
  // 要求）の場合は原典全体をそのまま使う
  if (!out) out = src;

  await drawFooter(out, PDFString, baseName, sourceUrls, docTypes);
  if (topLabel) await drawTopLabel(out, topLabel);

  return { bytes: await out.save(), rangeLabel, total, savedPages: out.getPageCount() };
}
