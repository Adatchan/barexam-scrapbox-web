// =============================================================================
// 司法試験論文式 → Scrapbox 変換  ブラウザ版
//
// 元の Python スクリプト bar_exam_to_scrapbox.py のロジックを JavaScript に移植。
// PDF パースは PDF.js、moj.go.jp の中継は Cloudflare Worker（同梱の
// worker/worker.js）が担当する。
// =============================================================================

// ─── 設定 ──────────────────────────────────────────────────────────────────
// Cloudflare Worker をデプロイした後、払い出された URL に書き換えてください。
// 例: "https://moj-proxy.yourname.workers.dev"
const WORKER_URL = "https://shihoshiken-proxy.adachiyuki0409.workers.dev";

const PDFJS_VERSION = "4.0.379";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

// ─── データテーブル ────────────────────────────────────────────────────────
const YEAR_URL_MAP = {
  h22: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00008.html",
  h23: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00047.html",
  h24: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00067.html",
  h25: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00082.html",
  h26: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00100.html",
  h27: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00113.html",
  h28: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00128.html",
  h29: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00145.html",
  h30: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00161.html",
  r1: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00177.html",
  r2: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00016.html",
  r3: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00056.html",
  r4: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00104.html",
  r5: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00198.html",
  r6: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00241.html",
  r7: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00267.html",
};

const RESULTS_URL_MAP = {
  h22: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00010.html",
  h23: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00030.html",
  h24: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00063.html",
  h25: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00079.html",
  h26: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00099.html",
  h27: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00111.html",
  h28: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00126.html",
  h29: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00142.html",
  h30: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00157.html",
  r1: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00175.html",
  r2: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00007.html",
  r3: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00051.html",
  r4: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00092.html",
  r5: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00196.html",
  r6: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00236.html",
  r7: "https://www.moj.go.jp/jinji/shihoushiken/jinji08_00265.html",
};

const NO_SAITEN = new Set(["r1"]);

// 科目 → [系列名, 問番号, 表示ラベル, 選択科目キーワード(任意)]
const SUBJECT_MAP = {
  憲法: ["公法系科目", 1, "公法系第１問（憲法）"],
  行政法: ["公法系科目", 2, "公法系第２問（行政法）"],
  民法: ["民事系科目", 1, "民事系第１問（民法）"],
  商法: ["民事系科目", 2, "民事系第２問（商法）"],
  民訴: ["民事系科目", 3, "民事系第３問（民事訴訟法）"],
  刑法: ["刑事系科目", 1, "刑事系第１問（刑法）"],
  刑訴: ["刑事系科目", 2, "刑事系第２問（刑事訴訟法）"],
  経済法第１問: ["選択科目", 1, "選択科目（経済法）第１問", "経済法"],
  経済法第２問: ["選択科目", 2, "選択科目（経済法）第２問", "経済法"],
};

const Q_KANJI = { 1: "１", 2: "２", 3: "３" };

const SELECT_SUBJECTS = [
  "倒産法",
  "租税法",
  "経済法",
  "知的財産法",
  "労働法",
  "環境法",
  "国際関係法（公法系）",
  "国際関係法（私法系）",
];

// ─── ユーティリティ ────────────────────────────────────────────────────────
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nosp(s) {
  return s.replace(/[\s　]+/g, "");
}

function resolveUrl(href, baseUrl) {
  if (/^https?:/.test(href)) return href;
  return new URL(href, baseUrl).toString();
}

// ─── 中継経由フェッチ ─────────────────────────────────────────────────────
async function fetchViaProxy(url, type = "text") {
  if (WORKER_URL.includes("example.workers.dev")) {
    throw new Error(
      "Cloudflare Worker の URL が未設定です。web/app.js の WORKER_URL を編集してください。",
    );
  }
  const proxyUrl = `${WORKER_URL}/?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) {
    throw new Error(`取得失敗 HTTP ${res.status}: ${url}`);
  }
  if (type === "arraybuffer") return await res.arrayBuffer();
  return await res.text();
}

async function fetchHtml(url) {
  return await fetchViaProxy(url, "text");
}
async function fetchPdf(url) {
  return await fetchViaProxy(url, "arraybuffer");
}

// ─── PDF URL 取得（試験問題） ─────────────────────────────────────────────
async function fetchExamPdfUrl(pageUrl, systemName) {
  const html = await fetchHtml(pageUrl);
  const idx = html.indexOf("論文式試験");
  const section = idx !== -1 ? html.slice(idx) : html;
  const escaped = reEscape(systemName);
  const PDF = `href="([^"#]+\\.pdf)"`;

  const patterns = [
    new RegExp(`${PDF}[^>]*>\\s*${escaped}\\s*<`),
    new RegExp(`${PDF}[^>]*>\\s*${escaped}`),
    new RegExp(`${PDF}[^>]*>(?:[^<]*<[^>]+>)*\\s*${escaped}`),
  ];
  for (const p of patterns) {
    const m = p.exec(section);
    if (m) return resolveUrl(m[1], pageUrl);
  }

  // Pattern 4: 最近接 PDF リンク
  let bestDist = Infinity;
  let bestHref = null;
  const nameRe = new RegExp(escaped, "g");
  const linkRe = new RegExp(PDF, "g");
  const names = [...section.matchAll(nameRe)];
  const links = [...section.matchAll(linkRe)];
  for (const nm of names) {
    for (const lm of links) {
      const dist = Math.abs(lm.index - nm.index);
      if (dist < bestDist) {
        bestDist = dist;
        bestHref = lm[1];
      }
    }
  }
  if (bestHref && bestDist < 500) return resolveUrl(bestHref, pageUrl);

  throw new Error(
    `「${systemName}」のPDFリンクが見つかりません。(ページ: ${pageUrl})`,
  );
}

// ─── PDF URL 取得（出題の趣旨） ───────────────────────────────────────────
async function fetchShushiPdfUrl(resultsUrl, sectionKeyword) {
  const html = await fetchHtml(resultsUrl);

  if (sectionKeyword) {
    const kw = reEscape(sectionKeyword);
    const p = new RegExp(
      `href="([^"#]+\\.pdf)"[^>]*>[^<]*(?:出題の趣旨[^<]*${kw}|${kw}[^<]*出題の趣旨)`,
    );
    const m = p.exec(html);
    if (m) return resolveUrl(m[1], resultsUrl);
  }

  const subM = /href="(\/jinji[^"]+\.html)"[^>]*>[^<]*出題の趣旨/.exec(html);

  if (subM && sectionKeyword) {
    const subUrl = resolveUrl(subM[1], resultsUrl);
    const subHtml = await fetchHtml(subUrl);
    const kw = reEscape(sectionKeyword);
    let m2 = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>[^<]*${kw}`).exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
    m2 = /href="([^"#]+\.pdf)"[^>]*>[^<]*選択科目/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
  }

  const p1 = /href="([^"#]+\.pdf)"[^>]*>[^<]*出題の趣旨/.exec(html);
  if (p1) return resolveUrl(p1[1], resultsUrl);

  if (subM) {
    const subUrl = resolveUrl(subM[1], resultsUrl);
    const subHtml = await fetchHtml(subUrl);
    const m2 = /href="([^"#]+\.pdf)"/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
  }

  throw new Error(
    `出題の趣旨PDFが見つかりません。(ページ: ${resultsUrl})`,
  );
}

// ─── PDF URL 取得（採点実感） ─────────────────────────────────────────────
async function fetchSaitenPdfUrl(resultsUrl, systemName, sectionKeyword) {
  const html = await fetchHtml(resultsUrl);

  if (sectionKeyword) {
    const kw = reEscape(sectionKeyword);
    const p = new RegExp(
      `href="([^"#]+\\.pdf)"[^>]*>[^<]*(?:採点実感[^<]*${kw}|${kw}[^<]*採点実感)`,
    );
    const m = p.exec(html);
    if (m) return resolveUrl(m[1], resultsUrl);
  }

  const directM = /href="([^"#]+\.pdf)"[^>]*>[^<]*採点実感/.exec(html);
  const subM = /href="(\/jinji[^"]+\.html)"[^>]*>[^<]*採点実感/.exec(html);

  if (subM) {
    const subUrl = resolveUrl(subM[1], resultsUrl);
    const subHtml = await fetchHtml(subUrl);
    const target = sectionKeyword || systemName;
    const escaped = reEscape(target);

    let m2 = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>[^<]*${escaped}`).exec(
      subHtml,
    );
    if (m2) return resolveUrl(m2[1], subUrl);

    if (sectionKeyword) {
      m2 = /href="([^"#]+\.pdf)"[^>]*>[^<]*選択科目/.exec(subHtml);
      if (m2) return resolveUrl(m2[1], subUrl);
    }

    m2 = /href="([^"#]+\.pdf)"[^>]*>[^<]*採点実感/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);

    m2 = /href="([^"#]+\.pdf)"/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
  }

  if (directM) return resolveUrl(directM[1], resultsUrl);

  throw new Error(
    `採点実感PDFが見つかりません。(ページ: ${resultsUrl})`,
  );
}

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
// pdfminer の LTTextBox 相当のデータを PDF.js から構築する。
// 各 box = { x0, x1, y1, text } で、ページ内で y1 降順。
//
// PDF.js は行単位（テキスト run 単位）の細かいアイテムしか返さない一方、
// pdfminer は近接する行を 1 つの LTTextBox（≒段落）にまとめて返す。
// 本コードでは
//   1) アイテムを行にまとめ
//   2) ベースライン間隔が行高の 1.5 倍未満なら同一段落として「ブロック」に集約
//   3) ブロックを 1 ボックスに統合して返す
// ことで pdfminer の挙動を近似する。
async function extractBoxes(pdfBytes, onProgress) {
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const boxes = [];

  for (let pn = 1; pn <= pdf.numPages; pn++) {
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

    if (items.length === 0) {
      onProgress && onProgress(pn / pdf.numPages);
      continue;
    }

    const lines = groupItemsIntoLines(items);
    const pageBoxes = groupLinesIntoBlocks(lines);
    pageBoxes.sort((a, b) => b.y1 - a.y1);
    boxes.push(...pageBoxes);

    onProgress && onProgress(pn / pdf.numPages);
  }

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

  const isRubyLine = (l) =>
    l.x1 - l.x0 < 80 && /^[ぁ-ん\s]+$/.test(l.text);

  // 行単体でヘッダー扱いすべき形（【...】単独 / 〔...〕単独 等）。
  // これらは前後の行と結合せず、単独ボックスとして扱う。
  const isStandaloneHeader = (l) => {
    const t = l.text.trim();
    if (/^【[^【】]+】$/.test(t)) return true;
    if (/^〔[^〔〕]+〕$/.test(t)) return true;
    if (/^〔第[１２３]問〕/.test(t) && t.length < 120) return true;
    if (/^〔設問\d+〕/.test(t) && t.length < 120) return true;
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

  // 文末記号で終わっているか（「。」「．」「！」「？」、後続に閉じカッコや空白を許容）
  const SENTENCE_END = /[。．！？!?][」』）)\s]*$/;

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

    if (cur.length === 0) {
      cur = [line];
      continue;
    }

    const prev = cur[cur.length - 1];
    const bbd = prev.yBaseline - line.yBaseline; // 上の行ほど y が大きい
    const avgH = (prev.height + line.height) / 2;

    // (1) 前の行が文末記号で終わっていなければほぼ確実に継続行 → 結合する。
    //     PDF の行間が広めで近接判定が外れても拾えるよう、行高の 3 倍まで許容。
    const prevEndsSentence = SENTENCE_END.test(prev.text);
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
function isHeader(b) {
  return /^(論文式試験問題集|［公法系科目］|［民事系科目］|［刑事系科目］|［選択科目)/.test(
    b.text,
  );
}
function isSaitenTitle(t) {
  return (
    /^[令平].{1,8}年司法試験/.test(t) && t.includes("採点実感") && t.length < 80
  );
}

// ─── 段落抽出（試験問題用、X 座標インデント判定） ───────────────────────
function parseParagraphs(boxes, startMarker, endMarker) {
  const si = boxes.findIndex((b) => b.text.includes(startMarker));
  if (si === -1) throw new Error(`開始マーカー「${startMarker}」が見つかりません。`);
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

    if (/^〔設問\d+〕/.test(t)) {
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

function parseShushiSection(boxes, systemName, qNum) {
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
  return parseNarrativeParagraphs(secBoxes.slice(qSi, qEi), skip);
}

function parseShushiSectionSelect(boxes, sectionKeyword, qNum) {
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
  return parseNarrativeParagraphs(secBoxes.slice(qSi, qEi), skip);
}

function parseSaitenSection(boxes, systemName, qNum, sectionKeyword) {
  const qKanji = Q_KANJI[qNum];
  let pattern, targetLabel;
  if (sectionKeyword) {
    pattern = new RegExp(
      `${reEscape(sectionKeyword)}[^第]{0,5}?第${reEscape(qKanji)}問`,
    );
    targetLabel = sectionKeyword;
  } else {
    pattern = new RegExp(`${reEscape(systemName)}第${reEscape(qKanji)}問`);
    targetLabel = systemName;
  }

  const isTargetTitle = (t) => isSaitenTitle(t) && pattern.test(t);

  const si = boxes.findIndex((b) => isTargetTitle(b.text));
  if (si === -1)
    throw new Error(
      `採点実感「${targetLabel}第${qKanji}問」のタイトルが見つかりません。`,
    );

  let ei = boxes.length;
  for (let i = si + 1; i < boxes.length; i++) {
    if (isSaitenTitle(boxes[i].text)) {
      ei = i;
      break;
    }
  }
  return parseNarrativeParagraphs(boxes.slice(si, ei));
}

// ─── Scrapbox 記法変換 ────────────────────────────────────────────────────
function toScrapbox(paras, yearLabel, subjectLabel, pdfUrl) {
  let tag;
  const m = /（(.+)）/.exec(subjectLabel);
  tag = m ? m[1] : subjectLabel;
  const out = [`${yearLabel}司法試験　${subjectLabel}`];
  if (pdfUrl) out.push(pdfUrl);
  out.push(`#司法試験 #${tag} #論文式 #${yearLabel}`);
  out.push("");
  for (const p of paras) {
    if (/^〔設問\d+〕/.test(p)) out.push(`[** ${p}]`);
    else if (/^【.+】/.test(p)) out.push(`[* ${p}]`);
    else out.push(p);
    out.push("");
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

function toScrapboxNarrative(paras, yearLabel, subjectLabel, docType, pdfUrl) {
  let tag;
  const m = /（(.+)）/.exec(subjectLabel);
  tag = m ? m[1] : subjectLabel;
  const out = [`${yearLabel}司法試験　${subjectLabel}　${docType}`];
  if (pdfUrl) out.push(pdfUrl);
  out.push(`#司法試験 #${tag} #論文式 #${yearLabel} #${docType}`);
  out.push("");
  for (const p of paras) {
    const ps = p.trim();
    if (isSaitenTitle(p)) out.push(`[** ${p}]`);
    else if (/^〔第[１２３]問〕$/.test(ps)) out.push(`[** ${ps}]`);
    else if (/^【.+】$/.test(ps)) out.push(`[* ${ps}]`);
    else if (
      p.length < 30 &&
      /^[１２３４５６７８９\d]+[　\s]/.test(p) &&
      !p.includes("\n")
    )
      out.push(`[* ${p}]`);
    else out.push(p);
    out.push("");
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

// ─── 実行ディスパッチ ─────────────────────────────────────────────────────
function parseYearKey(key) {
  if (key.startsWith("r")) return { key, label: `令和${key.slice(1)}年` };
  return { key, label: `平成${key.slice(1)}年` };
}

async function runConversion({ yearKey, subject, docType }, ctx) {
  const { log, setProgress } = ctx;
  if (!(yearKey in YEAR_URL_MAP)) throw new Error(`未対応の年度: ${yearKey}`);
  if (!(subject in SUBJECT_MAP)) throw new Error(`未対応の科目: ${subject}`);

  const { label: yearLabel } = parseYearKey(yearKey);
  const entry = SUBJECT_MAP[subject];
  const [systemName, qNum, subjectLabel, sectionKeyword] = entry;

  let pdfUrl;
  let referer;
  if (docType === "試験問題") {
    const pageUrl = YEAR_URL_MAP[yearKey];
    log(`取得中: ${yearLabel} ${subjectLabel}`);
    setProgress(0.05);
    pdfUrl = await fetchExamPdfUrl(pageUrl, systemName);
    referer = pageUrl;
  } else if (docType === "出題の趣旨") {
    if (!(yearKey in RESULTS_URL_MAP))
      throw new Error(`${yearLabel} は出題の趣旨に未対応です。`);
    const resultsUrl = RESULTS_URL_MAP[yearKey];
    log(`取得中: ${yearLabel} ${subjectLabel} 出題の趣旨`);
    setProgress(0.05);
    pdfUrl = await fetchShushiPdfUrl(resultsUrl, sectionKeyword);
    referer = resultsUrl;
  } else if (docType === "採点実感") {
    if (!(yearKey in RESULTS_URL_MAP))
      throw new Error(`${yearLabel} は採点実感に未対応です。`);
    if (NO_SAITEN.has(yearKey))
      throw new Error(`${yearLabel} の採点実感は法務省ウェブに掲載されていません。`);
    const resultsUrl = RESULTS_URL_MAP[yearKey];
    log(`取得中: ${yearLabel} ${subjectLabel} 採点実感`);
    setProgress(0.05);
    pdfUrl = await fetchSaitenPdfUrl(resultsUrl, systemName, sectionKeyword);
    referer = resultsUrl;
  } else {
    throw new Error(`未対応の種類: ${docType}`);
  }

  log(`  PDF: ${pdfUrl}`);
  setProgress(0.2);
  const pdfBytes = await fetchPdf(pdfUrl);
  log(`  ${pdfBytes.byteLength.toLocaleString()} バイト`);
  setProgress(0.4);

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
      throw new Error(
        `選択科目PDFに「${sectionKeyword}」が見つかりません。`,
      );
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

  let paras;
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
    paras = parseParagraphs(boxes, startMarker, endMarker);
  } else if (docType === "出題の趣旨") {
    if (sectionKeyword)
      paras = parseShushiSectionSelect(boxes, sectionKeyword, qNum);
    else paras = parseShushiSection(boxes, systemName, qNum);
  } else {
    paras = parseSaitenSection(boxes, systemName, qNum, sectionKeyword);
  }

  setProgress(0.95);

  const result =
    docType === "試験問題"
      ? toScrapbox(paras, yearLabel, subjectLabel, pdfUrl)
      : toScrapboxNarrative(paras, yearLabel, subjectLabel, docType, pdfUrl);

  setProgress(1.0);
  return { yearLabel, subjectLabel, docType, result };
}

// =============================================================================
// ─── UI ─────────────────────────────────────────────────────────────────────
// =============================================================================
const $ = (id) => document.getElementById(id);

function initSelectors() {
  const yearSelect = $("year");
  const keys = Object.keys(YEAR_URL_MAP).reverse();
  for (const k of keys) {
    const label = k.startsWith("r") ? `令和${k.slice(1)}年` : `平成${k.slice(1)}年`;
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = label;
    yearSelect.appendChild(opt);
  }

  const subjSelect = $("subject");
  for (const s of Object.keys(SUBJECT_MAP)) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    subjSelect.appendChild(opt);
  }
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.target).classList.add("active");
    });
  });
}

function appendLog(msg, kind = "info") {
  const log = $("log");
  const line = document.createElement("span");
  line.className = kind;
  const prefix =
    kind === "ok" ? "[OK] " : kind === "err" ? "[NG] " : kind === "warn" ? "[!] " : "";
  line.textContent = prefix + msg + "\n";
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function setStatus(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status " + kind;
}

function setProgressBar(frac) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  $("bar-fill").style.width = pct + "%";
  if (pct >= 100) setStatus("100% 完了", "ok");
  else if (pct === 0) setStatus("待機中");
  else setStatus(`${pct}% 進行中`);
}

let lastResult = "";

async function onRun() {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const docType = $("type").value;

  $("log").textContent = "";
  $("result").textContent = "";
  lastResult = "";
  $("copy").disabled = true;
  $("download").disabled = true;
  $("run").disabled = true;
  setProgressBar(0);
  setStatus("開始");

  // 結果タブを表示
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.target === "log"),
  );
  document
    .querySelectorAll(".pane")
    .forEach((p) => p.classList.toggle("active", p.id === "log"));

  try {
    const { yearLabel, subjectLabel, docType: dt, result } = await runConversion(
      { yearKey, subject, docType },
      {
        log: (m) => appendLog(m, "info"),
        setProgress: setProgressBar,
      },
    );
    lastResult = result;
    $("result").textContent = result;
    $("copy").disabled = false;
    $("download").disabled = false;
    appendLog(`完了: ${yearLabel} ${subjectLabel} ${dt}`, "ok");
    setStatus("完了", "ok");

    // 結果タブに切替
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.toggle("active", t.dataset.target === "result"));
    document
      .querySelectorAll(".pane")
      .forEach((p) => p.classList.toggle("active", p.id === "result"));
  } catch (e) {
    appendLog(e.message, "err");
    setStatus("エラー", "error");
  } finally {
    $("run").disabled = false;
  }
}

async function onCopy() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult);
    appendLog("クリップボードにコピーしました。", "ok");
  } catch (e) {
    appendLog(`コピー失敗: ${e.message}`, "err");
  }
}

function onDownload() {
  if (!lastResult) return;
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const docType = $("type").value;
  const yearLabel = yearKey.startsWith("r")
    ? `令和${yearKey.slice(1)}年`
    : `平成${yearKey.slice(1)}年`;
  const suffix =
    docType === "試験問題"
      ? "司法試験問題"
      : docType === "出題の趣旨"
        ? "出題の趣旨"
        : "採点実感";
  const filename = `${yearLabel}${subject}${suffix}（scrapbox記法）.txt`;
  const blob = new Blob([lastResult], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function checkWorkerStatus() {
  const el = $("worker-status");
  if (WORKER_URL.includes("example.workers.dev")) {
    el.textContent = "未設定（web/app.js の WORKER_URL を編集してください）";
    el.className = "err";
  } else {
    el.textContent = WORKER_URL;
    el.className = "ok";
  }
}

// ── 起動 ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initSelectors();
  setupTabs();
  checkWorkerStatus();
  $("run").addEventListener("click", onRun);
  $("copy").addEventListener("click", onCopy);
  $("download").addEventListener("click", onDownload);
});
