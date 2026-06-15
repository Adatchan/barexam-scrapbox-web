// =============================================================================
// しほしけ短答ダウンローダー  UI 層 + リンク探索
//
// 司法試験「短答式」の問題（憲法・民法・刑法）と正答及び配点を、年度別・
// 科目別に法務省ウェブの原典PDFから取得して保存する。論文式コンバーター
// （app.js）と取得基盤・PDF出力を共有する:
//   years.js   年度→法務省ページURL対応表（週次クロールが自動更新）
//   data.js    yearKeyToLabel（年度キー→表示ラベル）
//   moj.js     法務省ウェブからの取得（Cloudflare Worker 中継）
//   pdfout.js  原典PDFへの出典スタンプ印字・zip
//
// 短答式は論文式と違い、出題の趣旨・採点実感が無く、科目は憲法・民法・刑法の
// 3科目（この3科目別の出題は平成27年以降）。原典の構造もページが異なるため、
// リンク探索は論文式（moj.js）とは別にここで行う。
// =============================================================================
import { YEAR_URL_MAP, RESULTS_URL_MAP } from "./years.js";
import { yearKeyToLabel } from "./data.js";
import { TANTOU_NEWS } from "./news.js";
import { fetchPdf } from "./moj.js";
import {
  TANTOU_SUBJECTS as SUBJECTS,
  TANTOU_DOC_TYPES as DOC_TYPES,
  isThreeSubjectYear,
  findTantouQuestionPdfUrl,
  findTantouAnswerPdfUrl,
  resolveTantouSourceUrls,
} from "./tantou-moj.js";
import { buildStampedPdf, loadFflate } from "./pdfout.js";

const $ = (id) => document.getElementById(id);

// 対応年度: 試験問題ページ・結果ページの両方が登録済みで、かつ3科目制の年度。
function supportedYearKeys() {
  return Object.keys(YEAR_URL_MAP)
    .filter((k) => k in RESULTS_URL_MAP && isThreeSubjectYear(k))
    .reverse(); // 新しい年度を先頭に
}

// リンク探索は yearKey から原典ページURLを引いて tantou-moj.js に委譲する
// （巡回スクリプトと同じコードパスを共有するため、探索本体は URL を受け取る）。
function findQuestionPdfUrl(yearKey, subject) {
  return findTantouQuestionPdfUrl(YEAR_URL_MAP[yearKey], subject);
}
function findAnswerPdfUrl(yearKey, subject) {
  const resultsUrl = RESULTS_URL_MAP[yearKey];
  if (!resultsUrl)
    throw new Error(`${yearKeyToLabel(yearKey)} の結果ページが未登録です。`);
  return findTantouAnswerPdfUrl(resultsUrl, subject);
}
function resolveSourceUrls(yearKey, subject) {
  return resolveTantouSourceUrls(
    YEAR_URL_MAP[yearKey],
    RESULTS_URL_MAP[yearKey],
    subject,
  );
}

// ─── 画面初期化 ───────────────────────────────────────────────────────────
function initSelectors() {
  const yearSelect = $("year");
  for (const k of supportedYearKeys()) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = yearKeyToLabel(k);
    yearSelect.appendChild(opt);
  }
  const subjSelect = $("subject");
  for (const s of SUBJECTS) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    subjSelect.appendChild(opt);
  }
}

// 更新情報（短答式専用の TANTOU_NEWS を週次クロールが自動追記する）
function initNews() {
  const list = $("news-list");
  if (!list) return;
  for (const item of TANTOU_NEWS.slice(0, 5)) {
    const li = document.createElement("li");
    const date = document.createElement("span");
    date.className = "news-date";
    date.textContent = item.date;
    li.appendChild(date);
    li.appendChild(document.createTextNode(item.text));
    list.appendChild(li);
  }
}

// ─── ログ・進捗 ───────────────────────────────────────────────────────────
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
  $("bar").setAttribute("aria-valuenow", String(pct));
  if (pct >= 100) setStatus("100% 完了", "ok");
  else if (pct === 0) setStatus("待機中");
  else setStatus(`${pct}% 進行中`);
}

function setBusy(busy) {
  for (const id of ["q-save", "a-save", "zip-save"]) $(id).disabled = busy;
}

function currentYearLabel() {
  return yearKeyToLabel($("year").value);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 1種類（問題 or 正答）の原典PDFを取得し、左上の見出しスタンプと出典
// フッターを印字したバイト列と基本ファイル名を返す。問題は先頭の表紙
// （情報量のない「短答式試験問題集［科目］」のページ）を除く。
async function buildOnePdf(yearKey, subject, docType, sourceUrls) {
  const yearLabel = yearKeyToLabel(yearKey);
  const pdfUrl =
    docType === "問題"
      ? await findQuestionPdfUrl(yearKey, subject)
      : await findAnswerPdfUrl(yearKey, subject);
  appendLog(`  ${docType} PDF: ${pdfUrl}`);
  const pdfBytes = await fetchPdf(pdfUrl);
  appendLog(`  ${pdfBytes.byteLength.toLocaleString()} バイト`);
  const baseName = `${yearLabel}司法試験短答式${subject}${docType}`;
  // 左上ラベルの種類表記は「問題」か「正答」に短縮する
  const typeShort = docType === "問題" ? "問題" : "正答";
  const topLabel = `${yearLabel}　${subject}　${typeShort}`;
  // 問題は表紙（1ページ目）を除いた本文のみ。正答は1ページ構成なので全体。
  const pageRange = docType === "問題" ? [2, Number.MAX_SAFE_INTEGER] : null;
  const { bytes, total, savedPages } = await buildStampedPdf(
    pdfBytes,
    pageRange,
    baseName,
    sourceUrls,
    DOC_TYPES,
    topLabel,
  );
  return { bytes, baseName, total, savedPages, pdfUrl };
}

// ─── 保存処理（問題 / 正答 単体） ─────────────────────────────────────────
async function saveSingle(docType) {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  $("log").textContent = "";
  setBusy(true);
  setProgressBar(0.05);
  setStatus("取得中");
  try {
    appendLog(`取得開始: ${currentYearLabel()} 短答式 ${subject} ${docType}`);
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    setProgressBar(0.4);
    const { bytes, baseName, total, savedPages } = await buildOnePdf(
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
    const note =
      docType === "問題" ? `表紙を除く${savedPages}ページ` : `${savedPages}ページ`;
    appendLog(
      `保存しました（${note}・左上に見出し、下部に出典を印字）。`,
      "ok",
    );
    setProgressBar(1.0);
  } catch (e) {
    appendLog(`保存に失敗: ${e.message}`, "err");
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
  }
}

// ─── 保存処理（問題＋正答 一式zip） ───────────────────────────────────────
async function saveZip() {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  $("log").textContent = "";
  setBusy(true);
  setProgressBar(0.05);
  setStatus("一括取得中");
  try {
    const folder = `${yearLabel}司法試験短答式${subject}一式`;
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    setProgressBar(0.3);
    const files = {};
    let done = 0;
    for (const docType of DOC_TYPES) {
      try {
        appendLog(`一括取得: ${docType}`);
        const { bytes, baseName } = await buildOnePdf(
          yearKey,
          subject,
          docType,
          sourceUrls,
        );
        files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
        appendLog(`  ${docType}: OK`, "ok");
      } catch (e) {
        appendLog(`  ${docType} は取得できませんでした: ${e.message}`, "warn");
      }
      done++;
      setProgressBar(0.3 + 0.6 * (done / DOC_TYPES.length));
    }

    const names = Object.keys(files);
    if (names.length === 0)
      throw new Error("いずれのPDFも取得できませんでした。");

    const { zipSync } = await loadFflate();
    const zipped = zipSync(files, { level: 0 }); // PDFは圧縮済みなので格納のみ
    triggerDownload(
      new Blob([zipped], { type: "application/zip" }),
      `${folder}.zip`,
    );
    appendLog(`一括保存完了（${names.length}件を zip に格納）`, "ok");
    setProgressBar(1.0);
  } catch (e) {
    appendLog(`一括保存に失敗: ${e.message}`, "err");
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
  }
}

// ── 起動 ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initSelectors();
  initNews();
  $("q-save").addEventListener("click", () => saveSingle("問題"));
  $("a-save").addEventListener("click", () => saveSingle("正答及び配点"));
  $("zip-save").addEventListener("click", saveZip);

  const helpDialog = $("help-dialog");
  $("help").addEventListener("click", () => helpDialog.showModal());
  $("help-close").addEventListener("click", () => helpDialog.close());
  helpDialog.addEventListener("click", (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });
});
