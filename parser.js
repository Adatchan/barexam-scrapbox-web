// =============================================================================
// PDF 解析（PDF.js によるテキスト抽出と段落構造の復元）
//
// 元の Python スクリプト bar_exam_to_scrapbox.py（pdfminer ベース）の
// ロジックを移植したもの。pdfminer の LTTextBox 相当のデータを PDF.js
// から構築し、X 座標インデントや構造マーカーで段落に分解する。
// =============================================================================
import {
  reEscape,
  nosp,
  SETSUMON_RE,
  STRUCTURE_MARKER_RE,
  DIALOGUE_RE,
  SENTENCE_END_RE,
  isSaitenTitle,
} from "./rules.js";
import { Q_KANJI, SELECT_SUBJECTS } from "./data.js";

const PDFJS_VERSION = "4.0.379";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

// ─── PDF.js のロード ─────────────────────────────────────────────────────
let _pdfjsPromise = null;
async function loadPdfjs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = (async () => {
    const mod = await import(`${PDFJS_CDN}/pdf.min.mjs`);
    mod.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
    return mod;
  })();
  return _pdfjsPromise;
}

// ─── PDF → boxes 抽出 ─────────────────────────────────────────────────────
// 各 box = { x0, x1, y1, text, page } で、ページ内で y1 降順。
//
// PDF.js は行単位（テキスト run 単位）の細かいアイテムしか返さない一方、
// pdfminer は近接する行を 1 つの LTTextBox（≒段落）にまとめて返す。
// 本コードでは
//   1) アイテムを行にまとめ
//   2) ベースライン間隔が行高の 1.5 倍未満なら同一段落として「ブロック」に集約
//   3) ブロックを 1 ボックスに統合して返す
// ことで pdfminer の挙動を近似する。
// ページ抽出の同時実行数。PDF.js の worker は単一スレッドだが、複数ページの
// テキスト抽出要求を投げておくと、worker の解析とメインスレッドの box 構築を
// オーバーラップでき、ページ毎 await の往復待ちも消える。多すぎるとメモリを
// 圧迫する（同時に保持する textContent が増える）ため 4〜6 に制限する。
const EXTRACT_CONCURRENCY = 5;

export async function extractBoxes(pdfBytes, onProgress) {
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const n = pdf.numPages;
  const perPage = new Array(n); // ページ(0始まり) → そのページの boxes[]
  let done = 0;

  // 1ページ分を抽出して perPage[pn-1] に格納する
  const processPage = async (pn) => {
    const page = await pdf.getPage(pn);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it && it.str)
      .map((it) => ({
        text: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width || 0,
        height: it.height || 10,
      }));

    let pageBoxes = [];
    if (items.length > 0) {
      const lines = groupItemsIntoLines(items);
      pageBoxes = groupLinesIntoBlocks(lines);
      pageBoxes.sort((a, b) => b.y1 - a.y1);
      for (const b of pageBoxes) b.page = pn;
    }
    perPage[pn - 1] = pageBoxes;
    page.cleanup(); // 抽出後はページ資源を解放してメモリを抑える
    onProgress && onProgress(++done / n);
  };

  // 同時実行数を制限した worker プールで全ページを処理する（処理順は不定だが
  // ページ番号で格納するため結果は決定的）
  let next = 1;
  const runners = [];
  for (let i = 0; i < Math.min(EXTRACT_CONCURRENCY, n); i++) {
    runners.push(
      (async () => {
        for (let pn = next++; pn <= n; pn = next++) await processPage(pn);
      })(),
    );
  }
  await Promise.all(runners);

  // 下流（マーカー探索・段落復元）は文書順依存なのでページ順に連結する
  const boxes = [];
  for (let i = 0; i < n; i++) if (perPage[i]) boxes.push(...perPage[i]);
  return boxes;
}

// アイテム群を「行」にまとめる。Y 座標が近いものを同一行とする。
function groupItemsIntoLines(items) {
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 1) return b.y - a.y;
    return a.x - b.x;
  });

  const lines = [];
  let cur = [];
  let curY = null;
  let curH = null;

  for (const it of sorted) {
    if (!it.text) continue;
    if (curY === null) {
      cur = [it];
      curY = it.y;
      curH = it.height;
      continue;
    }
    const tol = Math.max(curH || it.height, 6) * 0.5;
    if (Math.abs(it.y - curY) <= tol) {
      cur.push(it);
      if (it.height > curH) curH = it.height;
    } else {
      lines.push(makeLine(cur));
      cur = [it];
      curY = it.y;
      curH = it.height;
    }
  }
  if (cur.length) lines.push(makeLine(cur));
  return lines;
}

function makeLine(items) {
  items.sort((a, b) => a.x - b.x);
  const text = items
    .map((it) => it.text)
    .join("")
    .replace(/\s+$/, "")
    .replace(/^\s+/, "");
  const heights = items.map((it) => it.height).filter((h) => h > 0);
  return {
    text,
    x0: Math.min(...items.map((it) => it.x)),
    x1: Math.max(...items.map((it) => it.x + it.width)),
    yBaseline: items[0].y,
    yTop: Math.max(...items.map((it) => it.y + it.height)),
    height: heights.length ? Math.max(...heights) : 10,
  };
}

// 行群を「ブロック（≒pdfminer の LTTextBox）」にまとめて 1 ボックスにする。
// ベースライン間距離が行高の 1.5 倍未満なら同一ブロックと判定（pdfminer
// 既定の line_margin=0.5 と等価）。ルビ（短い & 全部ひらがな）は単独ボックス
// として後段の isRuby() で除外させる。
function groupLinesIntoBlocks(lines) {
  const boxes = [];
  let cur = [];

  const flush = () => {
    if (cur.length === 0) return;
    const text = cur.map((l) => l.text).join("");
    if (text) {
      boxes.push({
        x0: Math.min(...cur.map((l) => l.x0)),
        x1: Math.max(...cur.map((l) => l.x1)),
        y1: Math.max(...cur.map((l) => l.yTop)),
        text,
      });
    }
    cur = [];
  };

  const isRubyLine = (l) => l.x1 - l.x0 < 80 && /^[ぁ-ん\s]+$/.test(l.text);

  // 行単体でヘッダー扱いすべき形（【...】単独 / 〔...〕単独 等）。
  // これらは前後の行と結合せず、単独ボックスとして扱う。
  const isStandaloneHeader = (l) => {
    const t = l.text.trim();
    if (/^【[^【】]+】$/.test(t)) return true;
    if (/^〔[^〔〕]+〕$/.test(t)) return true;
    if (/^〔第[１２３]問〕/.test(t) && t.length < 120) return true;
    if (SETSUMON_RE.test(t) && t.length < 120) return true;
    // 採点実感のセクションタイトル（句点で終わらないため、放置すると
    // 直後の本文と結合されてタイトル判定に失敗する年度がある）
    if (isSaitenTitle(t)) return true;
    return false;
  };

  const emitSolo = (line) => {
    flush();
    boxes.push({
      x0: line.x0,
      x1: line.x1,
      y1: line.yTop,
      text: line.text,
    });
  };

  for (const line of lines) {
    if (!line.text) continue;

    if (isRubyLine(line)) {
      // ルビは段落に混ぜず単独ボックスとして残す（後段の isRuby で除外）
      emitSolo(line);
      continue;
    }

    if (isStandaloneHeader(line)) {
      emitSolo(line);
      continue;
    }

    // 構造マーカー・会話文の開始行から新しいブロックを開始する
    // （行自体は後続と結合してよい）
    if (STRUCTURE_MARKER_RE.test(line.text) || DIALOGUE_RE.test(line.text)) {
      flush();
      cur = [line];
      continue;
    }

    if (cur.length === 0) {
      cur = [line];
      continue;
    }

    const prev = cur[cur.length - 1];
    const bbd = prev.yBaseline - line.yBaseline; // 上の行ほど y が大きい
    const avgH = (prev.height + line.height) / 2;

    // (1) 前の行が文末記号で終わっていなければほぼ確実に継続行 → 結合する。
    //     PDF の行間が広めで近接判定が外れても拾えるよう、行高の 3 倍まで許容。
    const prevEndsSentence = SENTENCE_END_RE.test(prev.text);
    if (!prevEndsSentence && bbd > 0 && bbd < avgH * 3) {
      cur.push(line);
      continue;
    }

    // (2) 文末で終わる場合は通常の近接判定。
    //     pdfminer 既定（line_margin=0.5）よりやや広めの 1.7 倍。
    const threshold = avgH * 1.7;
    if (bbd > 0 && bbd < threshold) {
      cur.push(line);
    } else {
      flush();
      cur = [line];
    }
  }
  flush();

  return boxes;
}

// ─── フィルタ判定 ─────────────────────────────────────────────────────────
function isRuby(b) {
  return b.x1 - b.x0 < 80 && /^[ぁ-ん\s]+$/.test(b.text);
}
function isPagenum(b) {
  return /^-\s*\d+\s*-$/.test(b.text);
}
export function isHeader(b) {
  return /^(論文式試験問題集|［公法系科目］|［民事系科目］|［刑事系科目］|［選択科目)/.test(
    b.text,
  );
}

// 抽出対象ボックス群が占めるページ範囲 [開始, 終了] を返す（1 始まり）
function pageRangeOf(boxes) {
  const pages = boxes.map((b) => b.page).filter((p) => Number.isInteger(p));
  if (!pages.length) return null;
  return [Math.min(...pages), Math.max(...pages)];
}

// ─── 段落抽出（試験問題用、X 座標インデント判定） ───────────────────────
export function parseParagraphs(boxes, startMarker, endMarker) {
  const si = boxes.findIndex((b) => b.text.includes(startMarker));
  if (si === -1)
    throw new Error(`開始マーカー「${startMarker}」が見つかりません。`);
  let ei = boxes.length;
  if (endMarker) {
    const idx = boxes.findIndex((b) => b.text.includes(endMarker));
    if (idx !== -1) ei = idx;
  }

  const paras = [];
  let cur = "";
  let prevX = null;
  let inLaw = false;

  for (let i = si; i < ei; i++) {
    const b = boxes[i];
    if (isRuby(b) || isPagenum(b) || isHeader(b)) continue;
    const t = b.text;
    const x0 = b.x0;

    if (SETSUMON_RE.test(t)) {
      if (cur) paras.push(cur);
      cur = "";
      paras.push(t);
      prevX = x0;
      inLaw = false;
      continue;
    }
    if (/^【.+】/.test(t)) {
      if (cur) paras.push(cur);
      cur = "";
      paras.push(t);
      prevX = x0;
      inLaw = false;
      continue;
    }
    // 【資料】等の見出し直後の短いタイトル行（例: 法律案の骨子の題名）は
    // 見出しと同じ行に結合する
    if (
      !cur &&
      paras.length &&
      /^【[^【】]+】$/.test(paras[paras.length - 1]) &&
      t.length < 40 &&
      !/[。．！？]$/.test(t) &&
      !STRUCTURE_MARKER_RE.test(t)
    ) {
      paras[paras.length - 1] += t;
      prevX = x0;
      continue;
    }
    if (/^第\d+条/.test(t)) {
      if (cur) paras.push(cur);
      cur = t;
      prevX = 999;
      inLaw = true;
      continue;
    }
    if (inLaw) {
      cur += t;
      continue;
    }
    // 構造マーカーや会話文の開始は新しい段落を開始する
    if (STRUCTURE_MARKER_RE.test(t) || DIALOGUE_RE.test(t)) {
      if (cur) paras.push(cur);
      cur = t;
      prevX = x0;
      continue;
    }

    // 会話の発言が改ページ等で分断された場合の継続
    // （発言が文末記号で終わっていなければ続きとみなして結合する）
    if (cur && DIALOGUE_RE.test(cur) && !SENTENCE_END_RE.test(cur)) {
      cur += t;
      prevX = x0;
      continue;
    }

    if (prevX === null || x0 > prevX + 5) {
      if (cur) paras.push(cur);
      cur = t;
    } else {
      cur += t;
    }
    prevX = x0;
  }
  if (cur) paras.push(cur);
  return { paras, pageRange: pageRangeOf(boxes.slice(si, ei)) };
}

// ─── narrative（出題の趣旨・採点実感）見出し判定 ───────────────────────
function isNarrativeHeading(t) {
  const ts = t.trim();
  if (!ts) return false;
  if (isSaitenTitle(ts)) return true;
  if (/^〔第[１２３]問〕\s*$/.test(ts)) return true;
  if (/^【.+】\s*$/.test(ts)) return true;
  if (/^第[一二三四五六七八九十\d]+[　\s]/.test(ts) && ts.length < 50)
    return true;
  if (
    /^[１２３４５６７８９\d]+[　\s]/.test(ts) &&
    ts.length < 35 &&
    !ts.includes("\n")
  )
    return true;
  return false;
}

function parseNarrativeParagraphs(secBoxes, extraSkip) {
  const paras = [];
  let cur = "";
  let prevX = null;

  for (const b of secBoxes) {
    if (isPagenum(b) || isRuby(b)) continue;
    if (extraSkip && extraSkip(b)) continue;
    const t = b.text;
    const x0 = b.x0;

    if (isNarrativeHeading(t)) {
      if (cur) paras.push(cur);
      cur = "";
      paras.push(t.trim());
      prevX = x0;
      continue;
    }

    if (prevX === null || x0 > prevX + 5) {
      if (cur) paras.push(cur);
      cur = t;
    } else {
      cur += t;
    }
    prevX = x0;
  }
  if (cur) paras.push(cur);
  return paras;
}

export function parseShushiSection(boxes, systemName, qNum) {
  const sysHeader = `【${systemName}】`;
  const sysNosp = nosp(sysHeader);

  const secSi = boxes.findIndex((b) => nosp(b.text).includes(sysNosp));
  if (secSi === -1) throw new Error(`「${sysHeader}」が見つかりません。`);

  let secEi = boxes.length;
  for (let i = secSi + 1; i < boxes.length; i++) {
    const tx = boxes[i].text.trim();
    if (/^【.+】$/.test(tx) && !nosp(tx).includes(sysNosp)) {
      secEi = i;
      break;
    }
  }
  const secBoxes = boxes.slice(secSi, secEi);

  const qMarker = `〔第${Q_KANJI[qNum]}問〕`;
  const qSi = secBoxes.findIndex((b) => b.text.includes(qMarker));
  if (qSi === -1)
    throw new Error(`「${qMarker}」が出題の趣旨PDF内に見つかりません。`);

  let qEi = secBoxes.length;
  if (Q_KANJI[qNum + 1]) {
    const nxt = `〔第${Q_KANJI[qNum + 1]}問〕`;
    for (let i = qSi + 1; i < secBoxes.length; i++) {
      if (secBoxes[i].text.includes(nxt)) {
        qEi = i;
        break;
      }
    }
  }

  const skip = (b) => {
    const t = b.text;
    return nosp(t).includes(sysNosp) && t.length < 20;
  };
  const qBoxes = secBoxes.slice(qSi, qEi);
  return {
    paras: parseNarrativeParagraphs(qBoxes, skip),
    pageRange: pageRangeOf(qBoxes),
  };
}

export function parseShushiSectionSelect(boxes, sectionKeyword, qNum) {
  const kwNosp = nosp(sectionKeyword);
  const otherNosp = SELECT_SUBJECTS.map((s) => nosp(s)).filter(
    (s) => s !== kwNosp,
  );

  const isSubjectHeader = (b, nameNosp) => {
    const ts = b.text.trim();
    return ts.length < 30 && nosp(ts).includes(nameNosp);
  };

  let secSi = boxes.findIndex((b) => isSubjectHeader(b, kwNosp));
  let secEi = boxes.length;
  if (secSi === -1) {
    secSi = 0; // 個別 PDF と仮定
  } else {
    for (let i = secSi + 1; i < boxes.length; i++) {
      if (otherNosp.some((on) => isSubjectHeader(boxes[i], on))) {
        secEi = i;
        break;
      }
    }
  }
  const secBoxes = boxes.slice(secSi, secEi);

  const qMarker = `〔第${Q_KANJI[qNum]}問〕`;
  const qSi = secBoxes.findIndex((b) => b.text.includes(qMarker));
  if (qSi === -1)
    throw new Error(
      `出題の趣旨PDF内の「${sectionKeyword}」セクションに「${qMarker}」が見つかりません。`,
    );

  let qEi = secBoxes.length;
  if (Q_KANJI[qNum + 1]) {
    const nxt = `〔第${Q_KANJI[qNum + 1]}問〕`;
    for (let i = qSi + 1; i < secBoxes.length; i++) {
      if (secBoxes[i].text.includes(nxt)) {
        qEi = i;
        break;
      }
    }
  }

  const skip = (b) => {
    const ts = b.text.trim();
    return ts.length < 10 && kwNosp === nosp(ts);
  };
  const qBoxes = secBoxes.slice(qSi, qEi);
  return {
    paras: parseNarrativeParagraphs(qBoxes, skip),
    pageRange: pageRangeOf(qBoxes),
  };
}

export function parseSaitenSection(
  boxes,
  systemName,
  qNum,
  sectionKeyword,
  subjectLabel,
) {
  const qKanji = Q_KANJI[qNum];
  const target = sectionKeyword || systemName;
  const escaped = reEscape(target);

  // タイトルの書式は年度・科目で異なる:
  //   問別:     令和７年司法試験の採点実感（公法系科目第１問）
  //   科目単位: 令和７年司法試験の採点実感（労働法）          ← 選択科目
  //   系列単位: 平成２３年新司法試験の採点実感等に関する意見（公法系科目）
  //   科目名:   平成２２年新司法試験の採点実感等に関する意見（憲法）
  // 問別タイトルを優先し、なければ科目・系列単位のセクション全体を返す
  // （その場合は第１問・第２問が分かれていないため両方を含む）。
  const patterns = [
    new RegExp(`${escaped}[^第]{0,5}?第${reEscape(qKanji)}問`),
    new RegExp(`[（(]${escaped}[）)]`),
  ];
  // 表示ラベル（例: 公法系第１問（憲法））から科目名を取り出してフォールバックに使う
  const subjM = /（(.+)）/.exec(subjectLabel || "");
  if (subjM && subjM[1] !== target) {
    patterns.push(new RegExp(`[（(]${reEscape(subjM[1])}[）)]`));
  }

  for (const pattern of patterns) {
    const si = boxes.findIndex(
      (b) => isSaitenTitle(b.text) && pattern.test(b.text),
    );
    if (si === -1) continue;
    let ei = boxes.length;
    for (let i = si + 1; i < boxes.length; i++) {
      if (isSaitenTitle(boxes[i].text)) {
        ei = i;
        break;
      }
    }
    const targetBoxes = boxes.slice(si, ei);
    return {
      paras: parseNarrativeParagraphs(targetBoxes),
      pageRange: pageRangeOf(targetBoxes),
    };
  }

  throw new Error(
    `採点実感「${target}第${qKanji}問」のタイトルが見つかりません。`,
  );
}
