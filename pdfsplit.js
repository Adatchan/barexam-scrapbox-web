// =============================================================================
// PDF の科目別ページ抽出・先頭ページ判定（PDF.js・DOM非依存）
//
// 予備試験は科目グループPDF（憲法・行政法 など）や全科目まとめた出題の趣旨
// PDFで公表されるため、個別科目で切り出すには各科目の開始ページを特定する
// 必要がある。各科目の本文は「［憲法］」「［行政法］」のような角括弧見出しが
// ページ先頭に置かれるので、それを手掛かりにページ範囲を求める。
// 短答ダウンローダー（tantou.js）と論文コンバーター（app.js）が共有する。
// =============================================================================
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379";
let _pdfjsPromise = null;
export function loadPdfjs() {
  if (!_pdfjsPromise)
    _pdfjsPromise = (async () => {
      const mod = await import(`${PDFJS_CDN}/pdf.min.mjs`);
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
      return mod;
    })();
  return _pdfjsPromise;
}

const nosp = (s) => s.replace(/[\s　]+/g, "");

// 扉ページ（「論文式試験問題集［経済法］」のような科目名だけの中央寄せ
// ページ）を本文ページと区別する閾値。これ以下の文字数なら扉・白紙とみなす。
// 扉(最長でも約24字)と本文(最短でも約200字)の間には十分な開きがある。
const DOORPAGE_MAX_LEN = 40;

// ページ先頭帯（上端から30%）のテキストを連結して空白除去した配列を返す。
// 科目見出しは必ずページ先頭にあるため、本文中の角括弧（［No.１］等）を
// 誤検出しないよう先頭帯に絞る。
// ただし選択科目PDFは各科目が扉ページ（科目名のみ・中央寄せ）から始まり、
// 上端帯には文字が無いため top では拾えない。この扉を境界に使わないと前の
// 科目の末尾に次科目の扉が混入する。そこで文字数が極端に少ないページ
// （扉・白紙）に限り全文を見出し判定の対象にする。
async function pageTopTexts(pdf) {
  const out = [];
  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const page = await pdf.getPage(pn);
    const H = page.getViewport({ scale: 1 }).height;
    const items = (await page.getTextContent()).items.filter((i) => i.str);
    const all = nosp(items.map((i) => i.str).join(""));
    if (all.length <= DOORPAGE_MAX_LEN) {
      out.push(all); // 扉・白紙ページは全文で見出しを拾う
      continue;
    }
    const top = items
      .filter((i) => i.transform[5] > H * 0.7)
      .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])
      .map((i) => i.str)
      .join("");
    out.push(nosp(top));
  }
  return out;
}

// 角括弧見出し ［name］（全角／半角の閉じ括弧を許容）がテキストに含まれるか
const hasHeader = (text, nameNosp) =>
  text.includes(`［${nameNosp}］`) ||
  text.includes(`［${nameNosp}]`) ||
  text.includes(`[${nameNosp}]`);

const Q_MARKER_RE = /〔第[0-9０-９一二三四五六七八九十]+問〕/;

// 最初に設問〔第○問〕を含むページ番号（1始まり）。無ければ1（＝除去しない）。
// 表紙・白紙・章扉など情報量のない先頭ページを除くために使う。
export async function firstContentPage(pdfBytes) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: pdfBytes }).promise;
  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const text = (await pdf.getPage(pn))
      .getTextContent()
      .then((c) => c.items.map((i) => i.str).join(""));
    if (Q_MARKER_RE.test(await text)) return pn;
  }
  return 1;
}

// 科目別のページ範囲 [開始, 終了]（1始まり・両端含む）を返す。
//   targetHeaders: 対象科目の見出し候補（例: ["憲法"]、選択科目なら複数）
//   allHeaders:    境界判定に使う全科目見出し（次の科目の開始＝対象の終端）
// 対象見出しが無ければ null（その年度・PDFに無い科目）。
export async function findSubjectPageRange(pdfBytes, targetHeaders, allHeaders) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: pdfBytes }).promise;
  const tops = await pageTopTexts(pdf);
  const n = tops.length;

  const targetN = targetHeaders.map(nosp);
  const otherN = allHeaders.map(nosp).filter((h) => !targetN.includes(h));

  let start = -1;
  for (let i = 0; i < n; i++) {
    if (targetN.some((h) => hasHeader(tops[i], h))) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  let end = n;
  // 開始ページの次ページ以降で、対象以外の科目見出しが現れたら手前で区切る
  for (let idx = start; idx < n; idx++) {
    if (otherN.some((h) => hasHeader(tops[idx], h))) {
      end = idx; // tops[idx] はページ idx+1 → 終端はその手前の idx ページ
      break;
    }
  }
  return [start, end];
}
