// =============================================================================
// 変換ディスパッチ
//
// 年度・科目・種類から PDF を特定し、取得（moj.js）→ 解析（parser.js）→
// 整形（format.js）を組み立てる。処理結果はキャッシュされ、テキスト変換と
// 原典PDF保存（単体・一括zip）が同じ取得・解析結果を共有して二重処理を防ぐ。
// =============================================================================
import { YEAR_URL_MAP, RESULTS_URL_MAP } from "./years.js";
import { SUBJECT_MAP, Q_KANJI, yearKeyToLabel } from "./data.js";
import { nosp } from "./rules.js";
import {
  fetchPdf,
  fetchExamPdfUrl,
  fetchShushiPdfUrl,
  fetchSaitenPdfUrl,
  cacheSourceLabel,
} from "./moj.js";
import {
  extractBoxes,
  isHeader,
  parseParagraphs,
  parseShushiSection,
  parseShushiSectionSelect,
  parseSaitenSection,
} from "./parser.js";
import { toScrapbox, toScrapboxNarrative } from "./format.js";

// 年度×科目×種類ごとの処理結果キャッシュ。
// 件数に加えて PDF バイト列の合計容量にも上限を設ける（モバイル考慮）
const sourceCache = new Map();
const SOURCE_CACHE_MAX_ENTRIES = 12;
const SOURCE_CACHE_MAX_BYTES = 30 * 1024 * 1024;

function cacheBytes() {
  let total = 0;
  for (const e of sourceCache.values()) total += e.pdfBytes?.byteLength || 0;
  return total;
}

function cachePut(key, entry) {
  sourceCache.delete(key);
  sourceCache.set(key, entry);
  while (
    sourceCache.size > 1 &&
    (sourceCache.size > SOURCE_CACHE_MAX_ENTRIES ||
      cacheBytes() > SOURCE_CACHE_MAX_BYTES)
  ) {
    sourceCache.delete(sourceCache.keys().next().value);
  }
}

// キャッシュエントリから呼び出し元向けの結果を組み立てる
function assembleResult(entry, docType, decorate) {
  const { yearLabel, subjectLabel, paras, pdfUrl, pageRange, pdfBytes } = entry;
  const result =
    docType === "試験問題"
      ? toScrapbox(paras, yearLabel, subjectLabel, pdfUrl, decorate)
      : toScrapboxNarrative(
          paras,
          yearLabel,
          subjectLabel,
          docType,
          pdfUrl,
          decorate,
        );
  return {
    yearLabel,
    subjectLabel,
    docType,
    result,
    pdfUrl,
    pageRange,
    pdfBytes,
  };
}

// 試験問題・出題の趣旨・採点実感のPDF直URLをまとめて解決する
// （PDF本体はダウンロードせずリンク特定のみ。HTMLキャッシュで軽量。
// 取得できない種類は null）。原典PDFフッターのリンク表示に使う。
export async function resolveSourceUrls(yearKey, subject) {
  const urls = { 試験問題: null, 出題の趣旨: null, 採点実感: null };
  if (!(yearKey in YEAR_URL_MAP) || !(subject in SUBJECT_MAP)) return urls;
  const [systemName, , , sectionKeyword] = SUBJECT_MAP[subject];

  try {
    urls["試験問題"] = await fetchExamPdfUrl(YEAR_URL_MAP[yearKey], systemName);
  } catch {
    /* 未掲載・取得失敗は null のまま */
  }
  if (yearKey in RESULTS_URL_MAP) {
    const resultsUrl = RESULTS_URL_MAP[yearKey];
    try {
      urls["出題の趣旨"] = await fetchShushiPdfUrl(resultsUrl, sectionKeyword);
    } catch {
      /* noop */
    }
    try {
      urls["採点実感"] = await fetchSaitenPdfUrl(
        resultsUrl,
        systemName,
        sectionKeyword,
      );
    } catch {
      /* noop */
    }
  }
  return urls;
}

export async function runConversion({ yearKey, subject, docType, decorate }, ctx) {
  const { log, setProgress } = ctx;
  if (!(yearKey in YEAR_URL_MAP)) throw new Error(`未対応の年度: ${yearKey}`);
  if (!(subject in SUBJECT_MAP)) throw new Error(`未対応の科目: ${subject}`);

  // 同じ年度・科目・種類を処理済みなら再取得せずキャッシュを使う
  const cacheId = `${yearKey}|${subject}|${docType}`;
  const cached = sourceCache.get(cacheId);
  if (cached) {
    log(
      `処理済みのため再取得を省略: ${cached.yearLabel} ${cached.subjectLabel} ${docType}`,
    );
    setProgress(1.0);
    return assembleResult(cached, docType, decorate);
  }

  const yearLabel = yearKeyToLabel(yearKey);
  const [systemName, qNum, subjectLabel, sectionKeyword] = SUBJECT_MAP[subject];

  let pdfUrl;
  if (docType === "試験問題") {
    const pageUrl = YEAR_URL_MAP[yearKey];
    log(`取得中: ${yearLabel} ${subjectLabel}`);
    setProgress(0.05);
    pdfUrl = await fetchExamPdfUrl(pageUrl, systemName);
  } else if (docType === "出題の趣旨") {
    if (!(yearKey in RESULTS_URL_MAP))
      throw new Error(`${yearLabel} は出題の趣旨に未対応です。`);
    const resultsUrl = RESULTS_URL_MAP[yearKey];
    log(`取得中: ${yearLabel} ${subjectLabel} 出題の趣旨`);
    setProgress(0.05);
    pdfUrl = await fetchShushiPdfUrl(resultsUrl, sectionKeyword);
  } else if (docType === "採点実感") {
    if (!(yearKey in RESULTS_URL_MAP))
      throw new Error(`${yearLabel} は採点実感に未対応です。`);
    const resultsUrl = RESULTS_URL_MAP[yearKey];
    log(`取得中: ${yearLabel} ${subjectLabel} 採点実感`);
    setProgress(0.05);
    pdfUrl = await fetchSaitenPdfUrl(resultsUrl, systemName, sectionKeyword);
  } else {
    throw new Error(`未対応の種類: ${docType}`);
  }

  log(`  PDF: ${pdfUrl}`);
  setProgress(0.2);
  const pdfBytes = await fetchPdf(pdfUrl, ({ cache }) => {
    const src = cacheSourceLabel(cache);
    if (src) log(`  取得元: ${src}`);
  });
  log(`  ${pdfBytes.byteLength.toLocaleString()} バイト`);
  setProgress(0.4);

  // PDF.js は渡した ArrayBuffer を worker に移譲（detach）するため、
  // 原典PDF保存用にコピーを確保しておく。
  const pdfBytesCopy = pdfBytes.slice(0);

  let boxes = await extractBoxes(pdfBytes, (f) => {
    setProgress(0.4 + 0.4 * f);
  });

  // 選択科目の試験問題: セクションを絞り込む
  if (docType === "試験問題" && sectionKeyword) {
    const kwNosp = nosp(sectionKeyword);
    let secStart = boxes.findIndex(
      (b) => nosp(b.text).includes(kwNosp) && isHeader(b),
    );
    if (secStart === -1)
      secStart = boxes.findIndex((b) => nosp(b.text).includes(kwNosp));
    if (secStart === -1)
      throw new Error(`選択科目PDFに「${sectionKeyword}」が見つかりません。`);
    let secEnd = boxes.length;
    for (let i = secStart + 1; i < boxes.length; i++) {
      if (
        boxes[i].text.includes("論文式試験問題集") &&
        !nosp(boxes[i].text).includes(kwNosp)
      ) {
        secEnd = i;
        break;
      }
    }
    boxes = boxes.slice(secStart, secEnd);
  }

  setProgress(0.85);

  let paras, pageRange;
  if (docType === "試験問題") {
    let startMarker = `〔第${Q_KANJI[qNum]}問〕`;
    let endMarker = null;
    if (Q_KANJI[qNum + 1]) {
      if (sectionKeyword) {
        const cand2 = `〔第${Q_KANJI[qNum + 1]}問〕`;
        if (boxes.some((b) => b.text.includes(cand2))) endMarker = cand2;
      } else {
        const cand = `論文式試験問題集［${systemName}第${Q_KANJI[qNum + 1]}問］`;
        if (boxes.some((b) => b.text.includes(cand))) endMarker = cand;
        else {
          const cand2 = `〔第${Q_KANJI[qNum + 1]}問〕`;
          if (boxes.some((b) => b.text.includes(cand2))) endMarker = cand2;
        }
      }
    }
    ({ paras, pageRange } = parseParagraphs(boxes, startMarker, endMarker));
  } else if (docType === "出題の趣旨") {
    if (sectionKeyword)
      ({ paras, pageRange } = parseShushiSectionSelect(
        boxes,
        sectionKeyword,
        qNum,
      ));
    else ({ paras, pageRange } = parseShushiSection(boxes, systemName, qNum));
  } else {
    ({ paras, pageRange } = parseSaitenSection(
      boxes,
      systemName,
      qNum,
      sectionKeyword,
      subjectLabel,
    ));
  }

  setProgress(0.95);

  const cacheEntry = {
    yearLabel,
    subjectLabel,
    paras,
    pdfUrl,
    pageRange,
    pdfBytes: pdfBytesCopy,
  };
  cachePut(cacheId, cacheEntry);

  setProgress(1.0);
  return assembleResult(cacheEntry, docType, decorate);
}
