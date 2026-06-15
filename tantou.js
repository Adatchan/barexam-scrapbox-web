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
import { fetchHtml, fetchPdf } from "./moj.js";
import { buildStampedPdf, loadFflate } from "./pdfout.js";

const $ = (id) => document.getElementById(id);

// 短答式が憲法・民法・刑法の3科目別に出題されるようになったのは平成27年から。
// それ以前（平成22〜26年）は公法系・民事系・刑事系の系列単位のため対象外。
const SUBJECTS = ["憲法", "民法", "刑法"];
// フッターに並べる短答式の種類（左から順に印字される）
const DOC_TYPES = ["問題", "正答及び配点"];

function isThreeSubjectYear(key) {
  const n = Number(key.slice(1));
  if (Number.isNaN(n)) return false;
  return key[0] === "r" ? true : n >= 27; // 令和は全て / 平成は27年以降
}

// 対応年度: 試験問題ページ・結果ページの両方が登録済みで、かつ3科目制の年度。
function supportedYearKeys() {
  return Object.keys(YEAR_URL_MAP)
    .filter((k) => k in RESULTS_URL_MAP && isThreeSubjectYear(k))
    .reverse(); // 新しい年度を先頭に
}

function resolveUrl(href, baseUrl) {
  if (/^https?:/.test(href)) return href;
  return new URL(href, baseUrl).toString();
}

// ─── リンク探索（問題） ───────────────────────────────────────────────────
// 試験問題ページの《短答式試験》セクション内から、科目名のアンカーに紐づく
// PDF を探す。《論文式試験》セクション（公法系・民事系…）と混ざらないよう、
// 短答式の見出しから論文式の見出しまでに範囲を絞る。
async function findQuestionPdfUrl(yearKey, subject) {
  const pageUrl = YEAR_URL_MAP[yearKey];
  const html = await fetchHtml(pageUrl);
  const si = html.indexOf("短答式試験");
  if (si === -1)
    throw new Error("試験問題ページに《短答式試験》の区分が見つかりません。");
  const ei = html.indexOf("論文式試験", si);
  const section = ei === -1 ? html.slice(si) : html.slice(si, ei);

  const m = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>\\s*${subject}\\s*<`).exec(
    section,
  );
  if (!m)
    throw new Error(`短答式「${subject}」の問題PDFリンクが見つかりません。`);
  return resolveUrl(m[1], pageUrl);
}

// ─── リンク探索（正答及び配点） ───────────────────────────────────────────
// 結果ページ →「短答式試験」サブページ →《正答及び配点》（年度により
// 「正解及び配点」表記）セクション内の科目名アンカーをたどる。科目名
// （憲法・民法・刑法）はこのサブページではこのセクションにしか現れない。
async function findAnswerPdfUrl(yearKey, subject) {
  const resultsUrl = RESULTS_URL_MAP[yearKey];
  if (!resultsUrl)
    throw new Error(`${yearKeyToLabel(yearKey)} の結果ページが未登録です。`);
  const html = await fetchHtml(resultsUrl);

  const subM = /href="([^"#]+\.html)"[^>]*>\s*短答式試験\s*</.exec(html);
  if (!subM)
    throw new Error("結果ページに「短答式試験」サブページのリンクが見つかりません。");
  const subUrl = resolveUrl(subM[1], resultsUrl);
  const subHtml = await fetchHtml(subUrl);

  let idx = -1;
  for (const kw of ["正答及び配点", "正解及び配点", "正答", "正解"]) {
    idx = subHtml.indexOf(kw);
    if (idx !== -1) break;
  }
  const region = idx === -1 ? subHtml : subHtml.slice(idx);

  const m = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>\\s*${subject}\\s*<`).exec(
    region,
  );
  if (!m)
    throw new Error(`短答式「${subject}」の正答・配点PDFリンクが見つかりません。`);
  return resolveUrl(m[1], subUrl);
}

// 問題・正答の原典PDF直URLをまとめて解決する（フッターのリンク表示用）。
// 取得できない種類は null。
async function resolveSourceUrls(yearKey, subject) {
  const urls = { 問題: null, 正答及び配点: null };
  try {
    urls["問題"] = await findQuestionPdfUrl(yearKey, subject);
  } catch {
    /* 未掲載・取得失敗は null のまま */
  }
  try {
    urls["正答及び配点"] = await findAnswerPdfUrl(yearKey, subject);
  } catch {
    /* noop */
  }
  return urls;
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

// 1種類（問題 or 正答）の原典PDFを取得し、全ページに出典フッターを
// 印字したバイト列と基本ファイル名を返す。
async function buildOnePdf(yearKey, subject, docType, sourceUrls) {
  const pdfUrl =
    docType === "問題"
      ? await findQuestionPdfUrl(yearKey, subject)
      : await findAnswerPdfUrl(yearKey, subject);
  appendLog(`  ${docType} PDF: ${pdfUrl}`);
  const pdfBytes = await fetchPdf(pdfUrl);
  appendLog(`  ${pdfBytes.byteLength.toLocaleString()} バイト`);
  const baseName = `${yearKeyToLabel(yearKey)}司法試験短答式${subject}${docType}`;
  const { bytes, total } = await buildStampedPdf(
    pdfBytes,
    null, // 短答式は科目ごとに1PDFなのでページ抜き出しは不要（全ページ）
    baseName,
    sourceUrls,
    DOC_TYPES,
  );
  return { bytes, baseName, total, pdfUrl };
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
    const { bytes, baseName, total } = await buildOnePdf(
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
    appendLog(`保存しました（全${total}ページ・出典フッター付き）。`, "ok");
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
