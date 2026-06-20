// =============================================================================
// しほしけコンバーター  UI 層
//
// 画面の初期化とイベントハンドラのみを持つ。実処理は各モジュールに分離:
//   rules.js   テキスト構造の共有ルール（正規表現・判定）
//   data.js    科目定義などのデータテーブル
//   years.js   年度→法務省ページURL対応表（週次クロールが自動更新）
//   news.js    更新情報（週次クロールが自動追記）
//   moj.js     法務省ウェブからの取得（Cloudflare Worker 中継）
//   parser.js  PDF解析（PDF.js）と段落構造の復元
//   format.js  テキスト整形（ノーマル / Scrapbox 記法）
//   convert.js 変換ディスパッチと処理結果キャッシュ
//   pdfout.js  原典PDFの抜き出し・スタンプ印字・zip
// =============================================================================
import { YEAR_URL_MAP } from "./years.js";
import { YOBI_YEAR_URL_MAP, YOBI_RESULTS_URL_MAP } from "./yobi-years.js";
import { NEWS } from "./news.js";
import { SUBJECT_MAP, yearKeyToLabel, subjectSystem, SYSTEM_BG } from "./data.js";
import { runConversion, convertText, resolveSourceUrls } from "./convert.js";
import { fetchPdf, cacheSourceLabel, formatKB } from "./moj.js";
import {
  YOBI_RONBUN_SUBJECTS,
  YOBI_RONBUN_DEF,
  YOBI_ALL_HEADERS,
  yobiSubjectCandidates,
  findYobiRonbunPdfUrl,
  findYobiShushiPdfUrl,
} from "./yobi-moj.js";
import { firstContentPage, findSubjectPageRange } from "./pdfsplit.js";
import { buildStampedPdf, loadFflate } from "./pdfout.js";
import { enhanceSelect } from "./colorselect.js";
import { celebrate, showToast } from "./effects.js";

const $ = (id) => document.getElementById(id);

// 試験種別（司法試験 / 予備試験）。予備は PDF収集モード（jinji07 系統・
// 科目グループ別・出題の趣旨は全科目まとめた1PDF・採点実感なし）。
function isYobi() {
  const el = document.querySelector('input[name="exam"]:checked');
  return !!el && el.value === "yobi";
}

// ─── 画面初期化 ───────────────────────────────────────────────────────────
// 試験種別の切替時にも呼ぶため、年度・科目のリストを作り直す。
function initSelectors() {
  const yobi = isYobi();
  const yearSelect = $("year");
  yearSelect.innerHTML = "";
  const yearKeys = yobi
    ? Object.keys(YOBI_YEAR_URL_MAP)
        .filter((k) => k in YOBI_RESULTS_URL_MAP)
        .reverse()
    : Object.keys(YEAR_URL_MAP).reverse();
  for (const k of yearKeys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = yearKeyToLabel(k);
    yearSelect.appendChild(opt);
  }
  if (yearSelect._cs) yearSelect._cs.refresh();

  const subjSelect = $("subject");
  subjSelect.innerHTML = "";
  const subs = yobi ? YOBI_RONBUN_SUBJECTS : Object.keys(SUBJECT_MAP);
  for (const s of subs) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    const sys = subjectSystem(s);
    if (sys) opt.style.backgroundColor = SYSTEM_BG[sys];
    subjSelect.appendChild(opt);
  }
  // 科目リストを作り直したらカスタムドロップダウンを再同期する
  if (subjSelect._cs) subjSelect._cs.refresh();
}

// 試験種別の切替: 予備モードでは種類・出力形式とテキスト変換系ボタンを隠し、
// PDF収集ボタンを出す。年度・科目も作り直す。
function applyExamMode() {
  const yobi = isYobi();
  $("type-field").hidden = yobi;
  $("format-field").hidden = yobi;
  $("shihou-actions").hidden = yobi;
  $("yobi-actions").hidden = !yobi;
  initSelectors();
  invalidateResult();
  $("log").textContent = "";
  $("result").textContent = "";
  setProgressBar(0);
}

function initNews() {
  const list = $("news-list");
  if (!list) return;
  for (const item of NEWS.slice(0, 5)) {
    const li = document.createElement("li");
    const date = document.createElement("span");
    date.className = "news-date";
    date.textContent = item.date;
    li.appendChild(date);
    li.appendChild(document.createTextNode(item.text));
    list.appendChild(li);
  }
}

// ─── タブ・ログ・進捗 ─────────────────────────────────────────────────────
function activatePane(target) {
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.target === target;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  document
    .querySelectorAll(".pane")
    .forEach((p) => p.classList.toggle("active", p.id === target));
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activatePane(tab.dataset.target));
  });
}

function appendLog(msg, kind = "info") {
  const log = $("log");
  const line = document.createElement("span");
  line.className = kind;
  const prefix =
    kind === "ok"
      ? "[OK] "
      : kind === "err"
        ? "[NG] "
        : kind === "warn"
          ? "[!] "
          : "";
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
  $("bar").setAttribute("aria-valuenow", String(pct));
  if (pct >= 100) setStatus("100% 完了", "ok");
  else if (pct === 0) setStatus("待機中");
  else setStatus(`${pct}% 進行中`);
}

// 変換・保存処理の排他制御。処理中は実行系ボタンをすべて無効化する
function setBusy(busy) {
  for (const id of ["run", "source", "source-zip", "llm"]) {
    $(id).disabled = busy;
  }
}

const convertCtx = () => ({
  log: (m) => appendLog(m, "info"),
  setProgress: setProgressBar,
});

// 並列取得時の変換コンテキスト。複数の runConversion が同時にログ・進捗を
// 出すため、各ログに種別タグを付けて交錯を読みやすくし、進捗バーは個別には
// 動かさない（呼び出し側が完了件数で集約管理する）。
const taggedCtx = (tag) => ({
  log: (m) => appendLog(`[${tag}] ${m.replace(/^\s+/, "")}`, "info"),
  setProgress: () => {},
});

// ボタン押下から成果物の出力までの所要時間をログに出す。各操作の先頭で
// performance.now() を控え、完了時に logElapsed(t0) を呼ぶ。
function logElapsed(t0) {
  appendLog(`所要時間: ${((performance.now() - t0) / 1000).toFixed(3)} 秒`, "ok");
}

// ─── 変換実行・テキスト出力 ───────────────────────────────────────────────
let lastResult = "";

function selectedFormat() {
  const el = document.querySelector('input[name="format"]:checked');
  return el ? el.value : "plain";
}

function currentYearLabel() {
  return yearKeyToLabel($("year").value);
}

async function onRun() {
  const t0 = performance.now();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const docType = $("type").value;
  const decorate = selectedFormat() === "scrapbox";

  $("log").textContent = "";
  $("result").textContent = "";
  lastResult = "";
  $("copy").disabled = true;
  $("download").disabled = true;
  setBusy(true);
  $("run").textContent = "処理中…";
  setProgressBar(0);
  setStatus("開始");
  activatePane("log");

  try {
    const { yearLabel, subjectLabel, docType: dt, result } =
      await convertText({ yearKey, subject, docType, decorate }, convertCtx());
    lastResult = result;
    $("result").textContent = result;
    $("copy").disabled = false;
    $("download").disabled = false;
    appendLog(`完了: ${yearLabel} ${subjectLabel} ${dt}`, "ok");
    logElapsed(t0);
    setStatus("完了", "ok");
    activatePane("result");
    celebrate("変換完了", "結果欄にテキストを表示しました");
  } catch (e) {
    appendLog(e.message, "err");
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
    $("run").textContent = "変換実行";
  }
}

async function onCopy() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult);
    appendLog("クリップボードにコピーしました。", "ok");
    celebrate("コピー完了", "クリップボードにコピーしました");
    showToast("クリップボードにコピーしました");
  } catch (e) {
    appendLog(`コピー失敗: ${e.message}`, "err");
  }
}

function onDownload() {
  if (!lastResult) return;
  const subject = $("subject").value;
  const docType = $("type").value;
  const formatSuffix =
    selectedFormat() === "scrapbox" ? "（scrapbox記法）" : "";
  // PDF 出力と同じ「[年度]司法試験[科目][種別]」の命名規則に揃える
  const filename = `${currentYearLabel()}司法試験${subject}${docType}${formatSuffix}.txt`;
  triggerDownload(
    new Blob([lastResult], { type: "text/plain;charset=utf-8" }),
    filename,
  );
  celebrate("TXTを保存", "ダウンロードフォルダに保存しました");
  showToast(`${filename} を保存しました`);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safari ではクリック直後の revoke でダウンロードが失敗することがある
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── 原典PDF保存 ─────────────────────────────────────────────────────────
// 選択中の種類の原典PDF（該当ページのみ）を保存する。
// 変換実行済みならキャッシュを再利用し、未処理なら自動で取得する。
async function onSaveSourcePdf() {
  const t0 = performance.now();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const docType = $("type").value;
  setBusy(true);
  let fallbackUrl = "";
  try {
    const { pdfUrl, pageRange, pdfBytes } = await runConversion(
      { yearKey, subject, docType, decorate: false },
      convertCtx(),
    );
    fallbackUrl = pdfUrl;
    const baseName = `${currentYearLabel()}司法試験${subject}${docType}`;
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    const { bytes, rangeLabel, total } = await buildStampedPdf(
      pdfBytes,
      pageRange,
      baseName,
      sourceUrls,
    );
    triggerDownload(
      new Blob([bytes], { type: "application/pdf" }),
      `${baseName}.pdf`,
    );
    appendLog(
      `原典PDFの該当ページ（${rangeLabel} / 原典 全${total}ページ）を保存しました。`,
      "ok",
    );
    logElapsed(t0);
    setStatus("完了", "ok");
    celebrate("PDFを保存", "原典から該当ページを抜き出しました");
    showToast("該当ページをPDFで保存しました");
  } catch (e) {
    appendLog(`原典PDFの保存に失敗: ${e.message}`, "err");
    if (fallbackUrl) {
      appendLog("元のPDFをそのまま開きます。", "warn");
      window.open(fallbackUrl, "_blank", "noopener");
    }
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
  }
}

// 試験問題・出題の趣旨・採点実感の3点を取得して zip で一括保存する
async function onSaveSourceZip() {
  const t0 = performance.now();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  setBusy(true);
  setStatus("一括取得中");
  setProgressBar(0.05);
  try {
    // zip 内は「[年度]司法試験[科目名]一式」フォルダにまとめる
    const folder = `${yearLabel}司法試験${subject}一式`;
    // フッターのリンク用に3種類のURLを先に1回だけ解決して共有する
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    setProgressBar(0.15);
    const docTypes = ["試験問題", "出題の趣旨", "採点実感"];
    const files = {};
    let done = 0;
    // 3種類を並列に取得・整形する（失敗は種類ごとに隔離）
    await Promise.allSettled(
      docTypes.map(async (docType) => {
        try {
          const { pageRange, pdfBytes } = await runConversion(
            { yearKey, subject, docType, decorate: false },
            taggedCtx(docType),
          );
          const baseName = `${yearLabel}司法試験${subject}${docType}`;
          const { bytes, rangeLabel, total } = await buildStampedPdf(
            pdfBytes,
            pageRange,
            baseName,
            sourceUrls,
          );
          files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
          appendLog(`  [${docType}] ${rangeLabel}（原典 全${total}ページ）`, "ok");
        } catch (e) {
          appendLog(`  [${docType}] 取得できませんでした: ${e.message}`, "warn");
        } finally {
          setProgressBar(0.15 + 0.8 * (++done / docTypes.length));
        }
      }),
    );

    const names = Object.keys(files);
    if (names.length === 0) {
      throw new Error("いずれのPDFも取得できませんでした。");
    }

    const { zipSync } = await loadFflate();
    // PDF は圧縮済みなので再圧縮せず格納のみ（level: 0）
    const zipped = zipSync(files, { level: 0 });
    triggerDownload(
      new Blob([zipped], { type: "application/zip" }),
      `${folder}.zip`,
    );
    setProgressBar(1.0);
    appendLog(`一括保存完了（${names.length}件を zip に格納）`, "ok");
    logElapsed(t0);
    setStatus("完了", "ok");
    celebrate("zipを保存", "3点の抜粋PDFをまとめました");
    showToast("一式zipを保存しました");
  } catch (e) {
    appendLog(`一括保存に失敗: ${e.message}`, "err");
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
  }
}

// 年度・科目・種類が変わったら、直前の変換結果に依存する
// コピー / .txt 保存を無効化する（古い内容と新しい選択の組合せで
// 保存される事故を防ぐ。処理キャッシュはキーが選択値なので破棄不要）
function invalidateResult() {
  lastResult = "";
  $("copy").disabled = true;
  $("download").disabled = true;
}

// 試験問題・出題の趣旨・採点実感を1つの Markdown にまとめて保存する。
// LLM が文脈を把握できるよう、冒頭にメタ情報と出典を付ける。
async function onSaveLlm() {
  const t0 = performance.now();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  setBusy(true);
  setStatus("LLM用ファイルを作成中");
  setProgressBar(0.05);
  try {
    const docTypes = ["試験問題", "出題の趣旨", "採点実感"];
    const byType = {}; // docType → { body, subjectLabel }
    const sourceUrls = {};
    let done = 0;
    // 3種類を並列取得（完了順は不定なので docType をキーに集約し、出力は固定順）
    await Promise.allSettled(
      docTypes.map(async (docType) => {
        try {
          const { result, pdfUrl, subjectLabel } = await runConversion(
            { yearKey, subject, docType, decorate: false },
            taggedCtx(docType),
          );
          // 変換結果の1行目（タイトル）と2行目（出典）を除き本文だけ取り出す
          const body = result.split("\n").slice(2).join("\n").trim();
          byType[docType] = { body, subjectLabel };
          if (pdfUrl) sourceUrls[docType] = pdfUrl;
          appendLog(`  [${docType}] OK`, "ok");
        } catch (e) {
          appendLog(`  [${docType}] 取得できませんでした: ${e.message}`, "warn");
        } finally {
          setProgressBar(0.05 + 0.9 * (++done / docTypes.length));
        }
      }),
    );

    const got = docTypes.filter((d) => byType[d]);
    if (got.length === 0)
      throw new Error("いずれの種類も取得できませんでした。");

    const subjectLabel = byType[got[0]].subjectLabel;
    const md = [];
    md.push(`# ${yearLabel}司法試験 論文式 ${subjectLabel}`);
    md.push("");
    md.push("> この文書は、日本の司法試験（法科大学院修了者等を対象とする");
    md.push("> 国家試験）の論文式試験の過去問題と、その出題趣旨・採点実感を");
    md.push("> まとめたものです。法律答案の作成・添削・解説の参考資料として");
    md.push("> 利用できます。");
    md.push("");
    md.push("## 書誌情報");
    md.push("");
    md.push(`- 試験: ${yearLabel}司法試験 論文式試験`);
    md.push(`- 科目: ${subjectLabel}`);
    md.push("- 出典: 法務省ウェブサイト（原典PDFを加工して作成）");
    for (const docType of docTypes) {
      if (sourceUrls[docType])
        md.push(`  - ${docType}: ${sourceUrls[docType]}`);
    }
    md.push("");
    md.push(
      "※ PDFからの自動抽出のため、原文と細部が異なる場合があります。",
    );
    md.push("");
    for (const docType of docTypes) {
      if (!byType[docType]) continue;
      md.push(`## ${docType}`);
      md.push("");
      md.push(byType[docType].body);
      md.push("");
    }

    const filename = `${yearLabel}司法試験${subject}_LLM用.md`;
    triggerDownload(
      new Blob([md.join("\n")], { type: "text/markdown;charset=utf-8" }),
      filename,
    );
    setProgressBar(1.0);
    appendLog(
      `LLM用ファイルを保存しました（${got.length}種類を統合）。`,
      "ok",
    );
    logElapsed(t0);
    setStatus("完了", "ok");
    celebrate("Markdownを保存", "LLMに渡せる1ファイルを作成しました");
    showToast("LLM用Markdownを保存しました");
  } catch (e) {
    appendLog(`LLM用ファイルの作成に失敗: ${e.message}`, "err");
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
  }
}

// ─── 予備試験モード（PDF収集） ───────────────────────────────────────────
// 予備試験はテキスト変換せず、試験問題（科目グループ別）と出題の趣旨
// （全科目まとめた1PDF）を出典フッター・左上見出し付きで保存する。
const YOBI_DOC_TYPES = ["試験問題", "出題の趣旨"];

function setBusyYobi(busy) {
  for (const id of ["yobi-q", "yobi-shushi", "yobi-zip"]) $(id).disabled = busy;
}

// 試験問題（科目グループPDF）・出題の趣旨（全科目まとめた1PDF）の原典直URLを
// まとめて解決する（フッター用）。試験問題は個別科目が属するグループPDFを指す。
async function resolveYobiSourceUrls(yearKey, subject) {
  const urls = { 試験問題: null, 出題の趣旨: null };
  const def = YOBI_RONBUN_DEF[subject];
  try {
    urls["試験問題"] = await findYobiRonbunPdfUrl(
      YOBI_YEAR_URL_MAP[yearKey],
      yobiSubjectCandidates(def.group),
    );
  } catch {
    /* 未掲載・取得失敗は null のまま */
  }
  try {
    urls["出題の趣旨"] = await findYobiShushiPdfUrl(
      YOBI_RESULTS_URL_MAP[yearKey],
    );
  } catch {
    /* noop */
  }
  return urls;
}

// 1種類（試験問題 or 出題の趣旨）の原典PDFを取得し、当該科目だけを切り出して
// （科目グループPDF・全科目まとめた趣旨PDFから）、左上の見出しと出典フッターを
// 印字したバイト列と基本ファイル名を返す。
async function buildYobiPdf(yearKey, subject, docType, sourceUrls) {
  const yearLabel = currentYearLabel();
  const def = YOBI_RONBUN_DEF[subject];

  let pdfUrl;
  let pageRange = null;
  if (docType === "試験問題") {
    pdfUrl = await findYobiRonbunPdfUrl(
      YOBI_YEAR_URL_MAP[yearKey],
      yobiSubjectCandidates(def.group),
    );
  } else {
    if (!def.sHeaders)
      throw new Error(`${subject}には出題の趣旨がありません。`);
    pdfUrl = await findYobiShushiPdfUrl(YOBI_RESULTS_URL_MAP[yearKey]);
  }
  appendLog(`  ${docType} PDF: ${pdfUrl}`);
  const pdfBytes = await fetchPdf(pdfUrl, ({ cache }) => {
    const src = cacheSourceLabel(cache);
    if (src) appendLog(`  取得元: ${src}`);
  });
  appendLog(`  ${formatKB(pdfBytes.byteLength)}`);

  // 科目別に切り出す。問題は科目見出し（無い科目は表紙等を除いた本文全体）、
  // 趣旨は全科目まとめたPDFから当該科目の見出しで切り出す。見出しが特定できない
  // 年度（画像化された趣旨PDFなど）は全体にフォールバックして警告を出す。
  // pdfUrl をキャッシュキーに渡し、別科目への切替で同じPDFの再解析を避ける。
  const headers = docType === "試験問題" ? def.qHeaders : def.sHeaders;
  if (headers) {
    pageRange = await findSubjectPageRange(
      pdfBytes.slice(0),
      headers,
      YOBI_ALL_HEADERS,
      pdfUrl,
    );
    if (!pageRange) {
      if (docType === "試験問題") {
        const start = await firstContentPage(pdfBytes.slice(0), pdfUrl);
        pageRange = [start, Number.MAX_SAFE_INTEGER];
        appendLog(
          `  「${subject}」の区分を特定できず、グループ全体を保存します（画像PDF等の可能性）。`,
          "warn",
        );
      } else {
        pageRange = null; // 趣旨は全科目をそのまま
        appendLog(
          `  「${subject}」の区分を特定できず、出題の趣旨は全体（全科目）を保存します（画像PDF等の可能性）。`,
          "warn",
        );
      }
    }
  } else if (docType === "試験問題") {
    const start = await firstContentPage(pdfBytes.slice(0));
    pageRange = [start, Number.MAX_SAFE_INTEGER];
  }

  const typeShort = docType === "試験問題" ? "問題" : "趣旨";
  const baseName = `${yearLabel}司法試験予備試験論文式${subject}${docType}`;
  const topLabel = `${yearLabel}　予備　${subject}　${typeShort}`;
  const { bytes, savedPages } = await buildStampedPdf(
    pdfBytes,
    pageRange,
    baseName,
    sourceUrls,
    YOBI_DOC_TYPES,
    topLabel,
  );
  return { bytes, baseName, savedPages, pdfUrl };
}

async function onSaveYobiSingle(docType) {
  const t0 = performance.now();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  $("log").textContent = "";
  $("result").textContent = "";
  setBusyYobi(true);
  setProgressBar(0.05);
  setStatus("取得中");
  activatePane("log");
  try {
    appendLog(
      `取得開始: ${currentYearLabel()} 予備試験 論文式 ${subject} ${docType}`,
    );
    const sourceUrls = await resolveYobiSourceUrls(yearKey, subject);
    setProgressBar(0.4);
    const { bytes, baseName, savedPages } = await buildYobiPdf(
      yearKey,
      subject,
      docType,
      sourceUrls,
    );
    setProgressBar(0.95);
    triggerDownload(
      new Blob([bytes], { type: "application/pdf" }),
      `${baseName}.pdf`,
    );
    appendLog(
      `保存しました（${savedPages}ページ・左上に見出し、下部に出典を印字）。`,
      "ok",
    );
    logElapsed(t0);
    setProgressBar(1.0);
    celebrate("PDFを保存", `${docType}を保存しました`);
    showToast(`${docType}のPDFを保存しました`);
  } catch (e) {
    appendLog(`保存に失敗: ${e.message}`, "err");
    setStatus("エラー", "error");
  } finally {
    setBusyYobi(false);
  }
}

async function onSaveYobiZip() {
  const t0 = performance.now();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  $("log").textContent = "";
  setBusyYobi(true);
  setProgressBar(0.05);
  setStatus("一括取得中");
  activatePane("log");
  try {
    const folder = `${yearLabel}司法試験予備試験論文式${subject}一式`;
    const sourceUrls = await resolveYobiSourceUrls(yearKey, subject);
    setProgressBar(0.3);
    const files = {};
    let done = 0;
    // 試験問題・出題の趣旨を並列に取得・整形する（失敗は種類ごとに隔離）
    await Promise.allSettled(
      YOBI_DOC_TYPES.map(async (docType) => {
        try {
          appendLog(`[${docType}] 取得開始`);
          const { bytes, baseName } = await buildYobiPdf(
            yearKey,
            subject,
            docType,
            sourceUrls,
          );
          files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
          appendLog(`  [${docType}] OK`, "ok");
        } catch (e) {
          appendLog(`  [${docType}] 取得できませんでした: ${e.message}`, "warn");
        } finally {
          setProgressBar(0.3 + 0.6 * (++done / YOBI_DOC_TYPES.length));
        }
      }),
    );

    const names = Object.keys(files);
    if (names.length === 0)
      throw new Error("いずれのPDFも取得できませんでした。");

    const { zipSync } = await loadFflate();
    const zipped = zipSync(files, { level: 0 });
    triggerDownload(
      new Blob([zipped], { type: "application/zip" }),
      `${folder}.zip`,
    );
    appendLog(`一括保存完了（${names.length}件を zip に格納）`, "ok");
    logElapsed(t0);
    setProgressBar(1.0);
    celebrate("zipを保存", "問題＋趣旨をまとめました");
    showToast("zipを保存しました");
  } catch (e) {
    appendLog(`一括保存に失敗: ${e.message}`, "err");
    setStatus("エラー", "error");
  } finally {
    setBusyYobi(false);
  }
}

// ── 起動 ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initSelectors();
  // 全プルダウンを同じカスタムドロップダウンに揃える。科目だけ系統色を付ける。
  enhanceSelect($("year"));
  enhanceSelect($("subject"), (v) => SYSTEM_BG[subjectSystem(v)]);
  enhanceSelect($("type"));
  initNews();
  setupTabs();
  for (const id of ["year", "subject", "type"]) {
    $(id).addEventListener("change", invalidateResult);
  }
  for (const r of document.querySelectorAll('input[name="exam"]')) {
    r.addEventListener("change", applyExamMode);
  }
  $("run").addEventListener("click", onRun);
  $("copy").addEventListener("click", onCopy);
  $("download").addEventListener("click", onDownload);
  $("source").addEventListener("click", onSaveSourcePdf);
  $("source-zip").addEventListener("click", onSaveSourceZip);
  $("llm").addEventListener("click", onSaveLlm);
  $("yobi-q").addEventListener("click", () => onSaveYobiSingle("試験問題"));
  $("yobi-shushi").addEventListener("click", () =>
    onSaveYobiSingle("出題の趣旨"),
  );
  $("yobi-zip").addEventListener("click", onSaveYobiZip);

  // ヘルプダイアログ（背景クリックでも閉じる）
  const helpDialog = $("help-dialog");
  $("help").addEventListener("click", () => helpDialog.showModal());
  $("help-close").addEventListener("click", () => helpDialog.close());
  helpDialog.addEventListener("click", (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });
});
