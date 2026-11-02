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
import { YOBI_YEAR_URL_MAP, YOBI_RESULTS_URL_MAP } from "./yobi-years.js";
import { yearKeyToLabel, subjectSystem, SYSTEM_BG } from "./data.js";
import { TANTOU_NEWS } from "./news.js";
import { fetchPdf } from "./moj.js";
import { celebrate, alarmError, showToast } from "./effects.js";
import {
  TANTOU_SUBJECTS,
  TANTOU_DOC_TYPES as DOC_TYPES,
  isThreeSubjectYear,
  findTantouQuestionPdfUrl,
  findTantouAnswerPdfUrl,
  resolveTantouSourceUrls,
} from "./tantou-moj.js";
import {
  YOBI_TANTOU_SUBJECTS,
  YOBI_TANTOU_DEF,
  YOBI_ALL_HEADERS,
  yobiSubjectCandidates,
} from "./yobi-moj.js";
import {
  firstContentPage,
  findSubjectPageRange,
  warmupPdfjs,
} from "./pdfsplit.js";
import { buildStampedPdf, loadFflate } from "./pdfout.js";
import { enhanceSelect } from "./colorselect.js";
import {
  setStatus,
  clearStatus,
  addNote,
  setActionButtons,
  startBusy,
  initNewsBar,
  triggerDownload,
} from "./ui.js";

const $ = (id) => document.getElementById(id);

// ─── 試験種別（司法試験 / 予備試験） ─────────────────────────────────────
// 予備試験は科目グループ別（憲法・行政法 など）・jinji07 系統で、短答式の
// ページ構造は司法試験と同じため、URLと科目だけ予備のものに差し替える。
function isYobi() {
  const el = document.querySelector('input[name="exam"]:checked');
  return !!el && el.value === "yobi";
}
function examLabel() {
  return isYobi() ? "司法試験予備試験" : "司法試験";
}
function yearMap() {
  return isYobi() ? YOBI_YEAR_URL_MAP : YEAR_URL_MAP;
}
function resultsMap() {
  return isYobi() ? YOBI_RESULTS_URL_MAP : RESULTS_URL_MAP;
}
function subjects() {
  return isYobi() ? YOBI_TANTOU_SUBJECTS : TANTOU_SUBJECTS;
}
// 取得対象。予備は個別科目が属するグループPDF（憲法・行政法 など）を取得し、
// 科目名の表記揺れ（一般教養科目／一般教養）に備えて別名候補を渡す。司法は
// 科目がそのままPDF単位なので科目名をそのまま使う。
function subjectArg(subject) {
  if (!isYobi()) return subject;
  return yobiSubjectCandidates(YOBI_TANTOU_DEF[subject].group);
}

// 対応年度: 試験問題ページ・結果ページの両方が登録済みの年度。司法試験は
// さらに3科目制（平成27年以降）に限る。予備試験は平成23年以降。
function supportedYearKeys() {
  const ym = yearMap();
  const rm = resultsMap();
  return Object.keys(ym)
    .filter((k) => k in rm && (isYobi() || isThreeSubjectYear(k)))
    .reverse(); // 新しい年度を先頭に
}

// リンク探索は yearKey から原典ページURLを引いて tantou-moj.js に委譲する
// （巡回スクリプトと同じコードパスを共有するため、探索本体は URL を受け取る）。
function findQuestionPdfUrl(yearKey, subject) {
  return findTantouQuestionPdfUrl(yearMap()[yearKey], subjectArg(subject));
}
function findAnswerPdfUrl(yearKey, subject) {
  const resultsUrl = resultsMap()[yearKey];
  if (!resultsUrl)
    throw new Error(`${yearKeyToLabel(yearKey)} の結果ページが未登録です。`);
  return findTantouAnswerPdfUrl(resultsUrl, subjectArg(subject));
}
function resolveSourceUrls(yearKey, subject) {
  return resolveTantouSourceUrls(
    yearMap()[yearKey],
    resultsMap()[yearKey],
    subjectArg(subject),
  );
}

// ─── 画面初期化 ───────────────────────────────────────────────────────────
// 試験種別の切替時にも呼ぶため、年度・科目のリストを作り直す。
function initSelectors() {
  const yearSelect = $("year");
  yearSelect.innerHTML = "";
  for (const k of supportedYearKeys()) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = yearKeyToLabel(k);
    yearSelect.appendChild(opt);
  }
  if (yearSelect._cs) yearSelect._cs.refresh();

  const subjSelect = $("subject");
  subjSelect.innerHTML = "";
  for (const s of subjects()) {
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

// ─── 保存されるファイルの案内 ─────────────────────────────────────────────
// 選択中の試験・年度・科目で、各ボタンが何を保存するかを示す。予備試験は
// 科目グループのまとめPDFから切り出すので、その旨を具体的に書く。
function updateSaveInfo() {
  const yobi = isYobi();
  const subject = $("subject").value;
  $("result-title").textContent = `${currentYearLabel()} ${yobi ? "予備試験" : "司法試験"} 短答式 ${subject}`;

  const def = yobi ? YOBI_TANTOU_DEF[subject] : null;
  const question =
    def && def.qHeaders
      ? `「${def.group}」のまとめPDFから、${subject}のページだけを切り出して保存します（区切りを特定できないときはグループ全体）。`
      : "表紙など設問の無い先頭ページを除いて保存します。";
  const answer =
    def && def.group !== subject
      ? `1ページの表に複数科目が載っているため、「${def.group}」の表をそのまま保存します。`
      : "各問の正解と配点をまとめた表を保存します。";
  const items = [
    ["問題PDF", question],
    ["正答・配点PDF", answer],
    ["一式 zip", "問題と正答及び配点の2点を、1つのフォルダにまとめたzipで保存します。"],
    ["共通", "どのPDFにも、左上に年度・科目・種類の見出し、下部に出典と加工した旨のフッター（原典PDFへのリンク付き）を印字します。"],
  ];
  const list = $("save-info");
  list.innerHTML = "";
  for (const [name, text] of items) {
    const li = document.createElement("li");
    const b = document.createElement("span");
    b.className = "save-info-name";
    b.textContent = name;
    li.append(b, document.createTextNode(text));
    list.appendChild(li);
  }
}

// ─── 実行ボタン ───────────────────────────────────────────────────────────
// 状態表示（#status）とボタン内の進捗は ui.js が担う。処理中は次のボタンを
// すべて無効化する。
setActionButtons(["q-save", "a-save", "zip-save"]);

function currentYearLabel() {
  return yearKeyToLabel($("year").value);
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
  const pdfBytes = await fetchPdf(pdfUrl);
  const baseName = `${yearLabel}${examLabel()}短答式${subject}${docType}`;
  // 左上ラベルの種類表記は「問題」か「正答」に短縮する
  const typeShort = docType === "問題" ? "問題" : "正答";
  const topLabel = `${yearLabel}　${isYobi() ? "予備　" : ""}${subject}　${typeShort}`;
  // 問題のページ範囲を決める。予備の分割科目はグループPDFから当該科目だけを
  // 切り出す。それ以外（司法、予備の一般教養）は表紙・白紙・章扉を除いた本文
  // （最初の設問のページ以降）のみ。正答及び配点は表紙が無いので全体。
  let pageRange = null;
  let split = false;
  if (docType === "問題") {
    const def = isYobi() ? YOBI_TANTOU_DEF[subject] : null;
    if (def && def.qHeaders) {
      pageRange = await findSubjectPageRange(
        pdfBytes.slice(0),
        def.qHeaders,
        YOBI_ALL_HEADERS,
        pdfUrl,
      );
      if (pageRange) {
        split = true;
      } else {
        // 切り出せない（画像PDF等）→ グループ全体（表紙等を除く）にフォールバック
        const start = await firstContentPage(pdfBytes.slice(0), pdfUrl);
        pageRange = [start, Number.MAX_SAFE_INTEGER];
        addNote(`「${subject}」の区分を特定できず、グループ全体を保存しました。`);
      }
    } else {
      const start = await firstContentPage(pdfBytes.slice(0));
      pageRange = [start, Number.MAX_SAFE_INTEGER];
    }
  }
  const { bytes, total, savedPages } = await buildStampedPdf(
    pdfBytes,
    pageRange,
    baseName,
    sourceUrls,
    DOC_TYPES,
    topLabel,
  );
  return { bytes, baseName, total, savedPages, split, pdfUrl };
}

// ─── 保存処理（問題 / 正答 単体） ─────────────────────────────────────────
async function saveSingle(docType, buttonId) {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const busy = startBusy(buttonId, "PDF作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    busy.progress(0.4);
    const { bytes, baseName } = await buildOnePdf(
      yearKey,
      subject,
      docType,
      sourceUrls,
    );
    busy.progress(0.95);
    triggerDownload(
      new Blob([bytes], { type: "application/pdf" }),
      `${baseName}.pdf`,
    );
    busy.progress(1.0);
    celebrate("PDFを保存", `${docType}を保存しました`);
    showToast(`${docType}のPDFを保存しました`);
  } catch (e) {
    setStatus(`${docType}のPDFを作成できませんでした: ${e.message}`, "error");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

// ─── 保存処理（問題＋正答 一式zip） ───────────────────────────────────────
async function saveZip() {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  const busy = startBusy("zip-save", "zip作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    const folder = `${yearLabel}${examLabel()}短答式${subject}一式`;
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    busy.progress(0.3);
    const files = {};
    let done = 0;
    // 問題・正答を並列に取得・整形する（失敗は種類ごとに隔離）
    await Promise.allSettled(
      DOC_TYPES.map(async (docType) => {
        try {
          const { bytes, baseName } = await buildOnePdf(
            yearKey,
            subject,
            docType,
            sourceUrls,
          );
          files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
        } catch (e) {
          addNote(`${docType}は取得できませんでした（${e.message}）`);
        } finally {
          busy.progress(0.3 + 0.6 * (++done / DOC_TYPES.length));
        }
      }),
    );

    const names = Object.keys(files);
    if (names.length === 0)
      throw new Error("いずれのPDFも取得できませんでした。");

    const { zipSync } = await loadFflate();
    const zipped = zipSync(files, { level: 0 }); // PDFは圧縮済みなので格納のみ
    triggerDownload(
      new Blob([zipped], { type: "application/zip" }),
      `${folder}.zip`,
    );
    busy.progress(1.0);
    celebrate("zipを保存", "問題＋正答をまとめました");
    showToast("一式zipを保存しました");
  } catch (e) {
    setStatus(`一式zipを作成できませんでした: ${e.message}`, "error");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

// ── 起動 ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initSelectors();
  // 全プルダウンを同じカスタムドロップダウンに揃える。科目だけ系統色を付ける。
  enhanceSelect($("year"));
  enhanceSelect($("subject"), (v) => SYSTEM_BG[subjectSystem(v)]);
  warmupPdfjs(); // PDF.js をアイドル時に先読みし初回クリックの待ちを隠す
  initNewsBar(TANTOU_NEWS);
  // 試験種別の切替で年度・科目リストを作り直し、案内・状態表示を更新する
  for (const r of document.querySelectorAll('input[name="exam"]')) {
    r.addEventListener("change", () => {
      initSelectors();
      clearStatus();
      updateSaveInfo();
    });
  }
  for (const id of ["year", "subject"]) {
    $(id).addEventListener("change", updateSaveInfo);
  }
  updateSaveInfo();
  $("q-save").addEventListener("click", () => saveSingle("問題", "q-save"));
  $("a-save").addEventListener("click", () =>
    saveSingle("正答及び配点", "a-save"),
  );
  $("zip-save").addEventListener("click", saveZip);

  const helpDialog = $("help-dialog");
  // 閉じるときは開いたときと同じ経路を戻る（.closing のアニメーション完了後に
  // close()。アニメーションが無効な環境でも保険のタイマーで必ず閉じる）
  function closeHelp() {
    if (helpDialog.classList.contains("closing")) return;
    helpDialog.classList.add("closing");
    const finish = () => {
      helpDialog.classList.remove("closing");
      helpDialog.close();
    };
    const fallback = setTimeout(finish, 250);
    helpDialog.addEventListener(
      "animationend",
      () => {
        clearTimeout(fallback);
        finish();
      },
      { once: true },
    );
  }
  $("help").addEventListener("click", () => helpDialog.showModal());
  $("help-close").addEventListener("click", closeHelp);
  helpDialog.addEventListener("click", (e) => {
    if (e.target === helpDialog) closeHelp();
  });
  helpDialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeHelp();
  });
});
