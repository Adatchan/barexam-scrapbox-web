// =============================================================================
// 予備試験 論文式のテキスト変換（取得→解析→科目切り出し→整形）
//
// 予備の問題・出題の趣旨は科目グループ（憲法・行政法 など）／全科目まとめた
// 1ファイルで公表されるため、司法（convert.js）のように1科目=1PDFにならない。
// そこで PDF 全体を PDF.js でテキスト抽出（parser.js）した後、本文先頭の
// インライン角括弧見出し ［科目名］ を境界に当該科目のボックスだけを切り出して
// から、司法と同じ段落復元（parseParagraphs）・整形（format.js）に流す。
//
// 画像化された PDF（テキストが抽出できない年度・科目）は文字起こしできない。
// その場合は自動でPDFに落とさず、明示的なエラーを投げて利用者に PDF ダウン
// ロード（buildYobiPdf 側）を促す（採否は利用者に委ねる方針）。
// =============================================================================
import { yearKeyToLabel } from "./data.js";
import { nosp } from "./rules.js";
import { extractBoxes, parseParagraphs } from "./parser.js";
import { toScrapbox, toScrapboxNarrative } from "./format.js";
import { fetchPdf, cacheSourceLabel, formatKB } from "./moj.js";
import { YOBI_YEAR_URL_MAP, YOBI_RESULTS_URL_MAP } from "./yobi-years.js";
import {
  YOBI_RONBUN_DEF,
  YOBI_ALL_HEADERS,
  yobiSubjectCandidates,
  findYobiRonbunPdfUrl,
  findYobiShushiPdfUrl,
} from "./yobi-moj.js";

// 整形時のタイトル・タグ（司法と区別する）
const YOBI_FMT = { examTitle: "司法試験予備試験", examTag: "司法試験予備試験" };

// テキストが薄すぎる（画像PDFの疑い）と判定する科目あたりの総文字数しきい値。
const MIN_TEXT_CHARS = 200;

// セクション見出し ［科目名］ がボックス先頭付近に現れるか。PDF内では見出しに
// 空白が入る（［憲 法］等）ため nosp で詰めてから閉じ括弧まで厳密一致する
// （「民事」と「民事訴訟法」、「民法」と「民事」の接頭辞衝突を避けるため）。
// 問題PDFは ［科目名］ がボックス先頭だが、出題の趣旨PDFは文書タイトルと同じ
// ボックスに連結することがある（「令和…出題趣旨［憲 法］…」）。そのため先頭
// HEADER_NEAR 文字以内に出現すればセクション開始とみなす。
const HEADER_NEAR = 40;
// 角括弧は年度により全角 ［ ］ と半角 [ ] が混在する（例: 令和4年は ［憲 法]）。
// 全角に正規化してから照合する。
function normBrackets(s) {
  return s.replace(/[[［]/g, "［").replace(/[\]］]/g, "］");
}
function subjectHeaderAt(box, names) {
  const t = normBrackets(nosp(box.text));
  return names.some((h) => {
    const idx = t.indexOf(`［${h}］`);
    return idx >= 0 && idx < HEADER_NEAR;
  });
}

// 科目グループPDF／全科目まとめPDFのボックス列から、対象科目の区分だけを
// 切り出す。対象見出しのボックスから、次の別科目見出しのボックス手前まで。
// 見出しが見つからなければ null（区分を特定できない）。
export function sliceYobiSubjectBoxes(boxes, targetHeaders, allHeaders) {
  const tgt = targetHeaders.map(nosp);
  const others = allHeaders.map(nosp).filter((h) => !tgt.includes(h));
  const s = boxes.findIndex((b) => subjectHeaderAt(b, tgt));
  if (s === -1) return null;
  let e = boxes.length;
  for (let i = s + 1; i < boxes.length; i++) {
    if (subjectHeaderAt(boxes[i], others)) {
      e = i;
      break;
    }
  }
  return boxes.slice(s, e);
}

// 年度・科目・種類から原典PDFを特定・取得し、解析→科目切り出し→段落（paras）
// まで作る。戻り値は整形前のキャッシュエントリ（precompute と共有）。
export async function buildYobiEntry({ yearKey, subject, docType }, ctx) {
  const { log = () => {}, setProgress = () => {} } = ctx || {};
  if (!(subject in YOBI_RONBUN_DEF))
    throw new Error(`未対応の科目: ${subject}`);
  const def = YOBI_RONBUN_DEF[subject];
  const yearLabel = yearKeyToLabel(yearKey);
  const subjectLabel = subject;

  // 原典PDFの特定
  let pdfUrl;
  let headers;
  if (docType === "試験問題") {
    if (!(yearKey in YOBI_YEAR_URL_MAP))
      throw new Error(`${yearLabel} は試験問題に未対応です。`);
    log(`取得中: ${yearLabel} 予備 ${subjectLabel} 試験問題`);
    setProgress(0.05);
    pdfUrl = await findYobiRonbunPdfUrl(
      YOBI_YEAR_URL_MAP[yearKey],
      yobiSubjectCandidates(def.group),
    );
    headers = def.qHeaders;
  } else if (docType === "出題の趣旨") {
    if (!def.sHeaders)
      throw new Error(`${subjectLabel}には出題の趣旨がありません。`);
    if (!(yearKey in YOBI_RESULTS_URL_MAP))
      throw new Error(`${yearLabel} は出題の趣旨に未対応です。`);
    log(`取得中: ${yearLabel} 予備 ${subjectLabel} 出題の趣旨`);
    setProgress(0.05);
    pdfUrl = await findYobiShushiPdfUrl(YOBI_RESULTS_URL_MAP[yearKey]);
    headers = def.sHeaders;
  } else {
    throw new Error(`予備試験では未対応の種類: ${docType}`);
  }

  log(`  PDF: ${pdfUrl}`);
  setProgress(0.2);
  const pdfBytes = await fetchPdf(pdfUrl, ({ cache }) => {
    const src = cacheSourceLabel(cache);
    if (src) log(`  取得元: ${src}`);
  });
  log(`  ${formatKB(pdfBytes.byteLength)}`);
  setProgress(0.4);

  // PDF.js は渡した ArrayBuffer を detach するため保存用コピーを確保。
  const pdfBytesCopy = pdfBytes.slice(0);
  const boxes = await extractBoxes(pdfBytes, (f) => setProgress(0.4 + 0.4 * f));

  // PDF全体がほぼ無文字なら画像PDF（自動でPDFには落とさず利用者に委ねる）。
  const pdfChars = boxes.reduce((n, b) => n + nosp(b.text).length, 0);
  if (pdfChars < MIN_TEXT_CHARS)
    throw new Error(
      `このPDFはテキストをほとんど抽出できませんでした（抽出${pdfChars}字）。` +
        `画像化されたPDFのためテキスト変換はできません。` +
        `PDFダウンロードをご利用ください。`,
    );

  // 科目で切り出す（qHeaders/sHeaders が null の科目＝単独PDFは全体）。
  let slice = boxes;
  if (headers) {
    slice = sliceYobiSubjectBoxes(boxes, headers, YOBI_ALL_HEADERS);
    if (!slice)
      throw new Error(
        `「${subjectLabel}」の区分（${headers.join("・")}の見出し）を` +
          `特定できませんでした。この年度・種類はテキスト変換に対応していません。` +
          `PDFダウンロードをご利用ください。`,
      );
  }

  // 出題の趣旨PDFは「問題と出題趣旨」が一体のため、各科目セクション内の
  // 「（出題の趣旨）」以降（＝趣旨本文）に絞る。問題文の再掲を落とす。
  // マーカーが無い年度・科目はセクション全体をそのまま流す。
  let startMarker = slice[0].text;
  if (docType === "出題の趣旨") {
    const mi = slice.findIndex((b) => b.text.includes("（出題の趣旨）"));
    if (mi !== -1) startMarker = "（出題の趣旨）";
  }

  setProgress(0.85);
  // 終了マーカーは不要（切り出し済み）。
  const { paras, pageRange } = parseParagraphs(slice, startMarker, null);
  setProgress(0.95);

  return { yearLabel, subjectLabel, paras, pdfUrl, pageRange, pdfBytes: pdfBytesCopy };
}

// エントリ→整形結果。試験問題は問題用、出題の趣旨はナラティブ用の整形を使う。
export function assembleYobiResult(entry, docType, decorate) {
  const { yearLabel, subjectLabel, paras, pdfUrl, pageRange, pdfBytes } = entry;
  const result =
    docType === "試験問題"
      ? toScrapbox(paras, yearLabel, subjectLabel, pdfUrl, decorate, YOBI_FMT)
      : toScrapboxNarrative(
          paras,
          yearLabel,
          subjectLabel,
          docType,
          pdfUrl,
          decorate,
          YOBI_FMT,
        );
  return { yearLabel, subjectLabel, docType, result, pdfUrl, pageRange, pdfBytes };
}

// ─── 処理結果キャッシュ（同一年度・科目・種類の再取得/再解析を避ける）──────
const yobiCache = new Map();
const YOBI_CACHE_MAX = 12;
function yobiCachePut(key, entry) {
  yobiCache.delete(key);
  yobiCache.set(key, entry);
  while (yobiCache.size > YOBI_CACHE_MAX)
    yobiCache.delete(yobiCache.keys().next().value);
}

// ─── 事前変換（静的JSON）───────────────────────────────────────────────────
// scripts/precompute.mjs が web/converted/yobi/<年度>/<科目>.json を生成する。
// 司法（converted/<年度>/）と年度キー・科目名が衝突するため yobi/ 配下に分ける。
const YOBI_PRECOMP_BASE = "./converted/yobi";
const yobiPrecompCache = new Map();
async function fetchYobiPrecomputed(yearKey, subject) {
  const key = `${yearKey}|${subject}`;
  if (yobiPrecompCache.has(key)) return yobiPrecompCache.get(key);
  let data = null;
  try {
    const url = `${YOBI_PRECOMP_BASE}/${yearKey}/${encodeURIComponent(subject)}.json`;
    const res = await fetch(url, { cache: "no-cache" });
    if (res.ok) data = await res.json();
  } catch {
    /* 静的ファイル無しはフォールバック */
  }
  yobiPrecompCache.set(key, data);
  return data;
}

// テキスト変換（表示用）。事前変換済みなら PDF.js を省略、無ければ取得→解析。
export async function convertYobiText(
  { yearKey, subject, docType, decorate },
  ctx,
) {
  const { log = () => {}, setProgress = () => {} } = ctx || {};

  const pre = await fetchYobiPrecomputed(yearKey, subject);
  const hit = pre && pre[docType];
  if (hit && Array.isArray(hit.paras)) {
    log("事前変換データを使用（PDF解析を省略）");
    setProgress(1.0);
    return assembleYobiResult(
      {
        yearLabel: yearKeyToLabel(yearKey),
        subjectLabel: subject,
        paras: hit.paras,
        pdfUrl: hit.pdfUrl,
        pageRange: null,
        pdfBytes: null,
      },
      docType,
      decorate,
    );
  }

  const cacheId = `${yearKey}|${subject}|${docType}`;
  const cached = yobiCache.get(cacheId);
  if (cached) {
    log(`処理済みのため再取得を省略: ${cached.yearLabel} ${cached.subjectLabel} ${docType}`);
    setProgress(1.0);
    return assembleYobiResult(cached, docType, decorate);
  }

  const entry = await buildYobiEntry({ yearKey, subject, docType }, ctx);
  yobiCachePut(cacheId, entry);
  setProgress(1.0);
  return assembleYobiResult(entry, docType, decorate);
}
