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
import { NEWS } from "./news.js";
import { SUBJECT_MAP, yearKeyToLabel } from "./data.js";
import { runConversion, resolveSourceUrls } from "./convert.js";
import { buildStampedPdf, loadFflate } from "./pdfout.js";

const $ = (id) => document.getElementById(id);

// ─── 画面初期化 ───────────────────────────────────────────────────────────
function initSelectors() {
  const yearSelect = $("year");
  const keys = Object.keys(YEAR_URL_MAP).reverse();
  for (const k of keys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = yearKeyToLabel(k);
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
  for (const id of ["run", "source", "source-zip"]) {
    $(id).disabled = busy;
  }
}

const convertCtx = () => ({
  log: (m) => appendLog(m, "info"),
  setProgress: setProgressBar,
});

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
  setProgressBar(0);
  setStatus("開始");
  activatePane("log");

  try {
    const { yearLabel, subjectLabel, docType: dt, result } =
      await runConversion({ yearKey, subject, docType, decorate }, convertCtx());
    lastResult = result;
    $("result").textContent = result;
    $("copy").disabled = false;
    $("download").disabled = false;
    appendLog(`完了: ${yearLabel} ${subjectLabel} ${dt}`, "ok");
    setStatus("完了", "ok");
    activatePane("result");
  } catch (e) {
    appendLog(e.message, "err");
    setStatus("エラー", "error");
  } finally {
    setBusy(false);
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
    setStatus("完了", "ok");
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
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  setBusy(true);
  setStatus("一括取得中");
  try {
    // zip 内は「[年度]司法試験[科目名]一式」フォルダにまとめる
    const folder = `${yearLabel}司法試験${subject}一式`;
    // フッターのリンク用に3種類のURLを先に1回だけ解決して共有する
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    const files = {};
    for (const docType of ["試験問題", "出題の趣旨", "採点実感"]) {
      try {
        appendLog(`一括取得: ${docType}`);
        const { pageRange, pdfBytes } = await runConversion(
          { yearKey, subject, docType, decorate: false },
          convertCtx(),
        );
        const baseName = `${yearLabel}司法試験${subject}${docType}`;
        const { bytes, rangeLabel, total } = await buildStampedPdf(
          pdfBytes,
          pageRange,
          baseName,
          sourceUrls,
        );
        files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
        appendLog(`  ${docType}: ${rangeLabel}（原典 全${total}ページ）`, "ok");
      } catch (e) {
        appendLog(`  ${docType} は取得できませんでした: ${e.message}`, "warn");
      }
    }

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
    appendLog(`一括保存完了（${names.length}件を zip に格納）`, "ok");
    setStatus("完了", "ok");
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

// ── 起動 ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initSelectors();
  initNews();
  setupTabs();
  for (const id of ["year", "subject", "type"]) {
    $(id).addEventListener("change", invalidateResult);
  }
  $("run").addEventListener("click", onRun);
  $("copy").addEventListener("click", onCopy);
  $("download").addEventListener("click", onDownload);
  $("source").addEventListener("click", onSaveSourcePdf);
  $("source-zip").addEventListener("click", onSaveSourceZip);

  // ヘルプダイアログ（背景クリックでも閉じる）
  const helpDialog = $("help-dialog");
  $("help").addEventListener("click", () => helpDialog.showModal());
  $("help-close").addEventListener("click", () => helpDialog.close());
  helpDialog.addEventListener("click", (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });
});
