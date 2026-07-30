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
  normSubject,
  hasMarker,
  normMarker,
  normalizeParagraphs,
  subjectPattern,
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
// 通常はブラウザで CDN から読み込むが、ビルド時の事前変換（Node の
// scripts/precompute.mjs）では pdfjs-dist を setPdfjs() で注入して同じ解析
// パイプラインを再利用する。
let _pdfjsPromise = null;
let _injectedPdfjs = null;

// Node 等から PDF.js モジュール（getDocument を持つ名前空間）を注入する。
export function setPdfjs(lib) {
  _injectedPdfjs = lib;
}

// getDocument に渡す追加オプション。CMap（CID フォントの文字コード表）が
// 無いと、埋め込みフォントの種類によってはテキストを1文字も取り出せない
// （例: 平成30年 民事系の採点実感）。ブラウザでは pdfjs-dist の npm 配信
// （jsDelivr）から取得する。Node（scripts/precompute.mjs）は同じ資産が
// node_modules にあるので setPdfDocOptions() でローカルパスを注入する。
const PDFJS_ASSETS = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
let _pdfDocOptions = {
  cMapUrl: `${PDFJS_ASSETS}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSETS}/standard_fonts/`,
};

export function setPdfDocOptions(opts) {
  _pdfDocOptions = { ..._pdfDocOptions, ...opts };
}

async function loadPdfjs() {
  if (_injectedPdfjs) return _injectedPdfjs;
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
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes, ..._pdfDocOptions })
    .promise;
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

// 行に重ねて描かれた句読点を、桁位置から求めた空白へ差し込む。
//
// 法務省のPDFには、行の文字列をひとまとまりで描いた上で、句読点や閉じ括弧
// だけを別の描画項目として本来の x 位置に重ねて置くものがある（採点実感など）。
// 本文側はその桁が空白になっている。PDF.js は描画順に項目を返すため、単純に
// 連結すると句読点が行末へ流れ、「要件のうち 「必要があると認、」のように
// 本文へ食い込む。等幅の全角文字なので、項目の幅と文字数から桁を逆算して
// 元の空白に戻せる。
const OVERLAY_RE = /^[、。，．）)」』〕】｣]$/;

// text の at 桁付近にある空白の位置（無ければ -1）
function nearestSpace(text, at) {
  for (const d of [0, 1, -1, 2, -2]) {
    const i = at + d;
    if (i >= 0 && i < text.length && /[ 　]/.test(text[i])) return i;
  }
  return -1;
}

export function mergeOverlaidPunctuation(items) {
  // 幅を持つ本文の項目を host とし、その範囲に重なる項目を差し込む
  const hosts = items.filter((it) => it.text.length > 2 && it.width > 0);
  if (!hosts.length) return items;
  const rest = [];
  for (const it of items) {
    if (hosts.includes(it)) continue;
    const host = hosts.find((h) => it.x > h.x && it.x < h.x + h.width);
    if (!host) {
      rest.push(it);
      continue;
    }
    if (!it.text.trim()) continue; // 隙間を埋めるだけの空白項目は捨てる
    if (!OVERLAY_RE.test(it.text)) {
      rest.push(it);
      continue;
    }
    const at = Math.round((it.x - host.x) / (host.width / host.text.length));
    const idx = nearestSpace(host.text, at);
    if (idx === -1) {
      rest.push(it); // 空白が無ければ元の位置が分からないので従来どおり
      continue;
    }
    host.text = host.text.slice(0, idx) + it.text + host.text.slice(idx + 1);
  }
  return [...hosts, ...rest];
}

function makeLine(rawItems) {
  const items = mergeOverlaidPunctuation(rawItems);
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

// ページ番号フッター/ヘッダー（「- 2 -」等）を箱テキストの先頭・末尾から
// 取り除く。行全体が「- N -」の箱は isPagenum でも除けるが、本文と同じ箱に
// 紛れ込んだもの（例「前記車両- 2 -」）はここで落として文の分断を防ぐ。
const DASH = "[-‐‑‒–—―−ーｰ－]";
const PAGENUM_TOKEN = `${DASH}\\s*[0-9０-９]{1,3}\\s*${DASH}`;
const PAGENUM_HEAD = new RegExp(`^\\s*${PAGENUM_TOKEN}\\s*`);
const PAGENUM_TAIL = new RegExp(`\\s*${PAGENUM_TOKEN}\\s*$`);
function stripFooterPageNum(text) {
  return text.replace(PAGENUM_HEAD, "").replace(PAGENUM_TAIL, "").trim();
}

// 行群を「ブロック（≒pdfminer の LTTextBox）」にまとめて 1 ボックスにする。
// ベースライン間距離が行高の 1.5 倍未満なら同一ブロックと判定（pdfminer
// 既定の line_margin=0.5 と等価）。ルビ（短い & 全部ひらがな）は単独ボックス
// として後段の isRuby() で除外させる。
// 開いたままの括弧の数
export function bracketDepth(text) {
  return (
    (text.match(/[（〔]/g) || []).length - (text.match(/[）〕]/g) || []).length
  );
}

// 深さ depth で開いている括弧が閉じる位置（その直後の添字）。閉じなければ -1
export function closeIndex(text, depth) {
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "（" || c === "〔") depth++;
    else if (c === "）" || c === "〕") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

// 階層見出しの書き出し（公用文作成の考え方 Ⅰ-6 ウ: 第１ → １ → （１） → ア）
const HEADING_MARKER_RE =
  /^(?:第[0-9０-９一二三四五六七八九十]{1,3}[　 ]|[0-9０-９]{1,2}[　 ]|[（(][0-9０-９]{1,2}[）)][　 ]?|[⑴-⒇][　 ]?|[ア-ン][　 ])/;

// 本文の右端。行の x1 の 80 パーセンタイルを使う（表や資料の飛び出しに
// 引きずられないよう最大値は取らない）。
export function textRightEdge(lines) {
  const xs = lines.map((l) => l.x1).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.8))];
}

// 階層見出しだけの行か。原典では見出しは独立した行に置かれ、本文の右端より
// ずっと手前で終わる。句点を挟まないため段落テキストからは切り出せないが、
// 座標を見れば「行が途中で終わっている」ことで判別できる。
//
//   ５ 学習者及び今後の法科大学院教育に求めるもの          ← 右端よりかなり手前
//   環境法を学習する際には、まず、環境法の基本構造と…      ← 右端まで埋まる
export function isHeadingOnlyLine(line, rightEdge) {
  const t = line.text.trim();
  if (!t || t.length > 40) return false;
  if (!HEADING_MARKER_RE.test(t)) return false;
  if (SENTENCE_END_RE.test(t)) return false; // 一文で終わる項目は見出しではない
  // 禁則処理で 1〜2 字早く折り返すことがあるので 4 字分の余裕を見る
  return line.x1 < rightEdge - line.height * 4;
}

function groupLinesIntoBlocks(lines) {
  const boxes = [];
  const rightEdge = textRightEdge(lines);
  let cur = [];

  const flush = () => {
    if (cur.length === 0) return;
    const text = stripFooterPageNum(cur.map((l) => l.text).join(""));
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
    // 「〔第 1 問〕」（半角数字・空白入り）の年度もあるため揺れを許容する
    if (/^〔第\s*[１２３1-3]\s*問〕/.test(t) && t.length < 120) return true;
    if (SETSUMON_RE.test(t) && t.length < 120) return true;
    // 採点実感のセクションタイトル（句点で終わらないため、放置すると
    // 直後の本文と結合されてタイトル判定に失敗する年度がある）
    if (isSaitenTitle(t)) return true;
    // 「２ 採点方針」「５ 学習者及び今後の法科大学院教育に求めるもの」のような
    // 階層見出しの行（座標で判別する）
    if (isHeadingOnlyLine(l, rightEdge)) return true;
    return false;
  };

  const emitSolo = (line, text = line.text) => {
    flush();
    boxes.push({
      x0: line.x0,
      x1: line.x1,
      y1: line.yTop,
      text,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.text) continue;

    if (isRubyLine(line)) {
      // ルビは段落に混ぜず単独ボックスとして残す（後段の isRuby で除外）
      emitSolo(line);
      continue;
    }

    if (isStandaloneHeader(line)) {
      // 「〔第２問〕（配点：１００〔…配点の割合は，」のように括弧が開いたまま
      // 次の行へ続く見出しは、閉じるところまで取り込んで1つの見出しにする。
      // 残り（本文の始まり）は通常の行として流す。
      let depth = bracketDepth(line.text);
      if (depth > 0 && i + 1 < lines.length) {
        const nxt = lines[i + 1];
        const cut = closeIndex(nxt.text, depth);
        if (cut !== -1) {
          emitSolo(line, line.text + nxt.text.slice(0, cut));
          const rest = nxt.text.slice(cut);
          if (rest) lines[i + 1] = { ...nxt, text: rest };
          else i++;
          continue;
        }
      }
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
  const si = boxes.findIndex((b) => hasMarker(b.text, startMarker));
  if (si === -1)
    throw new Error(`開始マーカー「${startMarker}」が見つかりません。`);
  let ei = boxes.length;
  if (endMarker) {
    const idx = boxes.findIndex((b) => hasMarker(b.text, endMarker));
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
      // 「〔設問１〕…具体的事実を摘示しつつ論じ」のように行が文の途中で
      // 終わっている場合は、次の行（「なさい。」）を結合できるよう cur に
      // 置く。マーカーだけの行や文が完結している行は独立した段落にする。
      if (SENTENCE_END_RE.test(t)) {
        paras.push(t);
        cur = "";
      } else {
        cur = t;
      }
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
      // 字下げに見えても、直前が文末で終わっていなければページ跨ぎ等で分割
      // された継続とみなして結合する（文・語の途中での改行を防ぐ）
      if (cur && !SENTENCE_END_RE.test(cur)) {
        cur += t;
      } else {
        if (cur) paras.push(cur);
        cur = t;
      }
    } else {
      cur += t;
    }
    prevX = x0;
  }
  if (cur) paras.push(cur);
  return {
    paras: normalizeParagraphs(paras),
    pageRange: pageRangeOf(boxes.slice(si, ei)),
  };
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
      // 字下げに見えても、直前が文末で終わっていなければページ跨ぎ等で分割
      // された継続とみなして結合する（文・語の途中での改行を防ぐ）
      if (cur && !SENTENCE_END_RE.test(cur)) {
        cur += t;
      } else {
        if (cur) paras.push(cur);
        cur = t;
      }
    } else {
      cur += t;
    }
    prevX = x0;
  }
  if (cur) paras.push(cur);
  // 段落内に埋もれた項目見出し（第１／１／（１）／ア／（ア））を独立させ、
  // 空白・ページ番号の残骸を落とす（公用文作成の考え方 Ⅰ-6 ウ）
  return normalizeParagraphs(paras);
}

// 選択科目の扉行（科目名だけの短い行）の位置を探す。PDFのテキスト抽出で
// 科目名が複数の片に分かれることがあるため（「国際関係法」＋「（公法系）」）、
// 直後の数片を連結したものでも照合する。本文を拾わないよう連結後も短い行に
// 限る。maxExtra を指定すると「科目名＋α文字」までの行だけを扉行とみなす。
function selectHeaderIndex(boxes, from, namesNosp, maxExtra = null) {
  const limit = (name) => (maxExtra === null ? 30 : name.length + maxExtra);
  for (let i = from; i < boxes.length; i++) {
    const headLen = normSubject(boxes[i].text).length;
    for (let n = 1; n <= 4 && i + n <= boxes.length; n++) {
      const joined = normSubject(
        boxes
          .slice(i, i + n)
          .map((b) => b.text)
          .join(""),
      );
      if (joined.length >= 30) break;
      const hit = namesNosp.some((name) => {
        if (joined.length >= limit(name)) return false;
        const at = joined.indexOf(name);
        // 科目名は先頭の片から始まっていること。後続の片だけに現れる場合は
        // その片の位置で改めて判定する（連結は名前の分断を繋ぐためのもの）。
        return at !== -1 && at < headLen;
      });
      if (hit) return i;
    }
    // 扉行が直後の本文と同じ片にまとまってしまい、上の長さ制限に掛からない
    // 場合の受け皿（平成22年の「［租 税 法］租税法の出題に関しては…」）。
    // 片の先頭が科目名（開き括弧1文字を許す）で、その直後が閉じ括弧や
    // 問マーカーのときだけ見出しとみなす。「租税法上の所得区分は…」のような
    // 本文の書き出しは除く。
    if (maxExtra === null) {
      const head = normSubject(boxes[i].text);
      for (const name of namesNosp) {
        const at = head.indexOf(name);
        if (at === -1 || at > 1) continue;
        if (at === 1 && !/[［【〔（([]/.test(head[0])) continue;
        if (/^[］】〕）)\]」〔【（(第]/.test(head.slice(at + name.length)))
          return i;
      }
    }
  }
  return -1;
}

const SELECT_NOSP = SELECT_SUBJECTS.map((s) => normSubject(s));

// 自問より前に戻る問マーカー（第２問の途中で現れる〔第１問〕など）の位置。
// 出題の趣旨は科目ごとに 第１問→第２問 の順で並ぶため、番号が戻ったら
// そこから先は別科目である。本文中の言及を拾わないよう行頭に限る。
function backwardQuestionIndex(boxes, from, qNum) {
  const marks = [];
  for (let k = 1; k <= qNum; k++)
    if (k !== qNum && Q_KANJI[k]) marks.push(normMarker(`〔第${Q_KANJI[k]}問〕`));
  if (!marks.length) return -1;
  for (let i = from; i < boxes.length; i++) {
    const t = normMarker(boxes[i].text);
    if (marks.some((m) => t.startsWith(m))) return i;
  }
  return -1;
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
  // 合冊PDFでは系科目の後ろに選択科目が続く。【…】形式の見出しを置かない
  // 年度があり（平成28年など）、そのままだと末尾まで取り込んでしまうため、
  // 選択科目の扉行でも打ち切る。
  const selEi = selectHeaderIndex(boxes, secSi + 1, SELECT_NOSP, 6);
  if (selEi !== -1 && selEi < secEi) secEi = selEi;

  const secBoxes = boxes.slice(secSi, secEi);

  const qMarker = `〔第${Q_KANJI[qNum]}問〕`;
  const qSi = secBoxes.findIndex((b) => hasMarker(b.text, qMarker));
  if (qSi === -1)
    throw new Error(`「${qMarker}」が出題の趣旨PDF内に見つかりません。`);

  let qEi = secBoxes.length;
  if (Q_KANJI[qNum + 1]) {
    const nxt = `〔第${Q_KANJI[qNum + 1]}問〕`;
    for (let i = qSi + 1; i < secBoxes.length; i++) {
      if (hasMarker(secBoxes[i].text, nxt)) {
        qEi = i;
        break;
      }
    }
  }
  // 選択科目の扉行を拾えなかった場合の備え（平成28年の倒産法など）
  const bi = backwardQuestionIndex(secBoxes, qSi + 1, qNum);
  if (bi !== -1 && bi < qEi) qEi = bi;

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
  const kwNosp = normSubject(sectionKeyword);
  const otherNosp = SELECT_SUBJECTS.map((s) => normSubject(s)).filter(
    (s) => s !== kwNosp,
  );

  let secSi = selectHeaderIndex(boxes, 0, [kwNosp]);
  let secEi = boxes.length;
  if (secSi === -1) {
    // 他科目の扉行があるなら合冊PDFであり、自科目だけ見つからないのは誤り。
    // 先頭（＝別科目）から取り込んでしまわないよう明示的に失敗させる。
    if (selectHeaderIndex(boxes, 0, otherNosp) !== -1)
      throw new Error(
        `出題の趣旨PDFに「${sectionKeyword}」の見出しが見つかりません。`,
      );
    secSi = 0; // 個別 PDF と仮定
  } else {
    const nxt = selectHeaderIndex(boxes, secSi + 1, otherNosp);
    if (nxt !== -1) secEi = nxt;
  }
  const secBoxes = boxes.slice(secSi, secEi);

  const qMarker = `〔第${Q_KANJI[qNum]}問〕`;
  const qSi = secBoxes.findIndex((b) => hasMarker(b.text, qMarker));
  if (qSi === -1)
    throw new Error(
      `出題の趣旨PDF内の「${sectionKeyword}」セクションに「${qMarker}」が見つかりません。`,
    );

  let qEi = secBoxes.length;
  if (Q_KANJI[qNum + 1]) {
    const nxt = `〔第${Q_KANJI[qNum + 1]}問〕`;
    for (let i = qSi + 1; i < secBoxes.length; i++) {
      if (hasMarker(secBoxes[i].text, nxt)) {
        qEi = i;
        break;
      }
    }
  }

  const skip = (b) => {
    const ts = b.text.trim();
    // 科目名だけの扉行（「労働法」「国際関係法（公法系）」など）を落とす
    return ts.length <= sectionKeyword.length + 2 && kwNosp === normSubject(ts);
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
  const escaped = subjectPattern(target);

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
    patterns.push(new RegExp(`[（(]${subjectPattern(subjM[1])}[）)]`));
  }

  for (const pattern of patterns) {
    // タイトルは「（国際関係法（公法系 ））」のように括弧の直前に空白が
    // 入る年度があるため、空白と半角括弧を正規化してから照合する。
    const si = boxes.findIndex(
      (b) =>
        isSaitenTitle(b.text) &&
        (pattern.test(b.text) || pattern.test(normSubject(b.text))),
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
