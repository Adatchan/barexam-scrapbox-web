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
//   search.js  事前変換データの全文検索
// =============================================================================
import { YEAR_URL_MAP, RESULTS_URL_MAP } from "./years.js";
import { YOBI_YEAR_URL_MAP, YOBI_RESULTS_URL_MAP } from "./yobi-years.js";
import { NEWS } from "./news.js";
import {
  SUBJECT_MAP,
  subjectSearchGroups,
  yearKeyToLabel,
  subjectSystem,
  SYSTEM_BG,
} from "./data.js";
import { runConversion, convertText, resolveSourceUrls } from "./convert.js";
import { convertYobiText } from "./yobi-convert.js";
import { fetchPdf } from "./moj.js";
import {
  YOBI_RONBUN_SUBJECTS,
  YOBI_RONBUN_DEF,
  YOBI_ALL_HEADERS,
  yobiSubjectCandidates,
  findYobiRonbunPdfUrl,
  findYobiShushiPdfUrl,
} from "./yobi-moj.js";
import {
  firstContentPage,
  findSubjectPageRange,
  warmupPdfjs,
} from "./pdfsplit.js";
import { buildStampedPdf, loadFflate } from "./pdfout.js";
import { enhanceSelect } from "./colorselect.js";
import { celebrate, alarmError, showToast } from "./effects.js";
import {
  setStatus,
  clearStatus,
  addNote,
  setActionButtons,
  startBusy,
  initNewsBar,
  triggerDownload,
} from "./ui.js";
import {
  searchSubject,
  normalizeQuery,
  preloadSearchIndex,
} from "./search.js";

const $ = (id) => document.getElementById(id);

// 種類セグメントの表示名（値は「試験問題」等のまま。JSON・ファイル名に使う）
const TYPE_SHORT = {
  試験問題: "問題",
  出題の趣旨: "趣旨",
  採点実感: "実感",
};

// 種類（試験問題／出題の趣旨／採点実感）の現在値と設定
function currentType() {
  const el = document.querySelector('#type input[name="type"]:checked');
  return el ? el.value : "試験問題";
}

function setType(value) {
  const el = document.querySelector(
    `#type input[name="type"][value="${value}"]`,
  );
  if (el) el.checked = true;
  return !!el;
}

// 「ファイルで保存」の一式zip・LLM用は科目単位で、司法は3点（問題・趣旨・
// 実感）、予備は2点（問題・趣旨）をまとめる。ボタンの小ラベルと説明を合わせる。
function updateSavePills() {
  const n = isYobi() ? "2点" : "3点";
  const kinds = isYobi()
    ? "試験問題・出題の趣旨"
    : "試験問題・出題の趣旨・採点実感";
  $("zip-pill").textContent = n;
  $("llm-pill").textContent = n;
  $("save-zip").title = `この科目の${kinds}の抜粋PDFを1つのzipにまとめて保存します`;
  $("save-llm").title = `この科目の${kinds}を、メタ情報・出典付きの1つのMarkdownにまとめて保存します（LLMに渡す用）`;
}

// 試験種別（司法試験 / 予備試験）。予備は PDF収集モード（jinji07 系統・
// 科目グループ別・出題の趣旨は全科目まとめた1PDF・採点実感なし）。
function isYobi() {
  const el = document.querySelector('input[name="exam"]:checked');
  return !!el && el.value === "yobi";
}

// ─── 画面初期化 ───────────────────────────────────────────────────────────
// 試験種別の切替時にも呼ぶため、年度・科目・種類のリストを作り直す。
function initSelectors() {
  const yobi = isYobi();

  // 種類: 予備に採点実感は無いため2種類。司法は3種類。
  // セグメント（ラジオ）で作り、表示は短縮名（問題・趣旨・実感）にする。
  const typeBox = $("type");
  const keepType = currentType();
  typeBox.innerHTML = "";
  const typeOpts = yobi
    ? ["試験問題", "出題の趣旨"]
    : ["試験問題", "出題の趣旨", "採点実感"];
  for (const t of typeOpts) {
    const label = document.createElement("label");
    label.className = "seg-item";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "type";
    input.value = t;
    input.setAttribute("aria-label", t);
    input.checked = t === keepType;
    const span = document.createElement("span");
    span.textContent = TYPE_SHORT[t] || t;
    label.append(input, span);
    typeBox.appendChild(label);
  }
  if (!typeBox.querySelector("input:checked"))
    typeBox.querySelector("input").checked = true;

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

// 試験種別の切替: 司法・予備で画面は共通。年度・科目・種類を作り直し、
// 保存ボタンの点数表示（予備は採点実感なし）を合わせて、テキストを表示し直す。
function applyExamMode() {
  initSelectors();
  updateSavePills();
  clearStatus();
  refreshResult();
}

// ─── ダイアログ（ヘルプ・全文検索で共通）─────────────────────────────────
// 閉じるときは開いたときと同じ経路を戻る（.closing のアニメーション完了後に
// close()。アニメーションが無効な環境でも保険のタイマーで必ず閉じる）。
function closeDialog(dlg) {
  if (!dlg.open || dlg.classList.contains("closing")) return;
  dlg.classList.add("closing");
  const finish = () => {
    dlg.classList.remove("closing");
    dlg.close();
  };
  const fallback = setTimeout(finish, 250);
  dlg.addEventListener(
    "animationend",
    () => {
      clearTimeout(fallback);
      finish();
    },
    { once: true },
  );
}

function setupDialog(dialogId, openId, closeId, onOpen) {
  const dlg = $(dialogId);
  $(openId).addEventListener("click", () => {
    dlg.showModal();
    onOpen && onOpen();
  });
  $(closeId).addEventListener("click", () => closeDialog(dlg));
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeDialog(dlg); // 背景クリック
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault(); // Esc もアニメーションを通して閉じる
    closeDialog(dlg);
  });
}

function closeSearch() {
  closeDialog($("search-dialog"));
}

// ─── 全文検索 ─────────────────────────────────────────────────────────────
// 事前に正規化した検索用索引（converted/search/）を科目単位で読み、キーワードに
// 一致する年度・種類をカードで一覧する。カードを押すと画面の選択欄へ反映する。
let searchToken = 0; // 連打時に古い検索結果で上書きしないための世代番号
let searchGroups = []; // 検索プルダウンの科目グループ（選択科目は2問まとめ）

// 検索ダイアログ内で選ばれている試験種別（メイン画面とは独立に切り替えられる）
function searchIsYobi() {
  const el = document.querySelector('input[name="search-exam"]:checked');
  return !!el && el.value === "yobi";
}

// 科目グループの色分けはメイン画面の科目プルダウンと同じ規則にする
function searchGroupColor(value) {
  const g = searchGroups[Number(value)];
  return g ? SYSTEM_BG[subjectSystem(g.label)] : "";
}

// 科目プルダウン（と種類チェックボックス）を、いま選ばれている試験に合わせて
// 作り直す。preferMain=true のときはメイン画面で選択中の科目に合わせる。
function buildSearchSubjects(preferMain) {
  const yobi = searchIsYobi();
  const subjSelect = $("search-subject");
  // 試験を切り替えても同じ科目を選び続けられるよう、切替前のラベルを覚えておく
  // （司法「経済法第１問/第２問」↔ 予備「経済法」のように問の分割だけが違う）
  const prevLabel = searchGroups[Number(subjSelect.value)]?.label;
  const baseOf = (s) => s.replace(/第[１２]問(\/第[１２]問)?$/, "");

  searchGroups = subjectSearchGroups(
    yobi ? YOBI_RONBUN_SUBJECTS : Object.keys(SUBJECT_MAP),
  );

  subjSelect.innerHTML = "";
  searchGroups.forEach((g, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = g.label;
    const sys = subjectSystem(g.label);
    if (sys) opt.style.backgroundColor = SYSTEM_BG[sys];
    subjSelect.appendChild(opt);
  });

  const cur = $("subject").value;
  const byCurrent = preferMain
    ? searchGroups.findIndex((g) => g.subjects.includes(cur))
    : -1;
  const byLabel = prevLabel
    ? searchGroups.findIndex((g) => baseOf(g.label) === baseOf(prevLabel))
    : -1;
  const pick = byCurrent >= 0 ? byCurrent : byLabel >= 0 ? byLabel : 0;
  subjSelect.value = String(pick);
  if (subjSelect._cs) subjSelect._cs.refresh();

  const typeBox = $("search-types");
  typeBox.innerHTML = "";
  const types = yobi
    ? ["試験問題", "出題の趣旨"]
    : ["試験問題", "出題の趣旨", "採点実感"];
  for (const t of types) {
    const label = document.createElement("label");
    label.className = "radio";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = t;
    cb.checked = true;
    label.append(cb, document.createTextNode(t));
    typeBox.appendChild(label);
  }
}

// ダイアログを開くたびに、メイン画面の試験・科目に合わせて作り直す
function initSearchControls() {
  const exam = isYobi() ? "yobi" : "shihou";
  const radio = document.querySelector(
    `input[name="search-exam"][value="${exam}"]`,
  );
  if (radio) radio.checked = true;
  buildSearchSubjects(true);
}

// 選択中の科目の索引を先に取り寄せ、検索を押したら照合だけで済むようにする
function preloadSelectedSearch() {
  const group = searchGroups[Number($("search-subject").value)];
  if (group) preloadSearchIndex(searchIsYobi(), group.subjects);
}

function selectedSearchTypes() {
  return [...$("search-types").querySelectorAll("input:checked")].map(
    (i) => i.value,
  );
}

// ヒット1件分のカード。押すと年度・科目・種類を画面へ反映して閉じる。
function buildHitCard(hit, showSubject, onPick) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "hit-card";

  const head = document.createElement("div");
  head.className = "hit-head";
  const year = document.createElement("span");
  year.className = "hit-year";
  year.textContent = hit.yearLabel;
  head.appendChild(year);
  if (showSubject) {
    const subj = document.createElement("span");
    subj.className = "hit-type hit-subject";
    subj.textContent = hit.subject;
    head.appendChild(subj);
  }
  const type = document.createElement("span");
  type.className = "hit-type";
  type.textContent = hit.docType;
  const count = document.createElement("span");
  count.className = "hit-count";
  count.textContent = `${hit.count}件`;
  head.append(type, count);

  const snip = document.createElement("div");
  snip.className = "hit-snippet";
  const mark = document.createElement("mark");
  mark.textContent = hit.snippet.match;
  snip.append(
    document.createTextNode(hit.snippet.before),
    mark,
    document.createTextNode(hit.snippet.after),
  );

  card.append(head, snip);
  card.addEventListener("click", () => onPick(hit));
  return card;
}

async function onSearch() {
  const query = $("search-input").value.trim();
  const results = $("search-results");
  const status = $("search-status");
  results.innerHTML = "";

  if (!normalizeQuery(query)) {
    status.textContent = "キーワードを入力してください。";
    return;
  }
  const types = selectedSearchTypes();
  if (!types.length) {
    status.textContent = "種類を1つ以上選んでください。";
    return;
  }

  const yobi = searchIsYobi();
  const group = searchGroups[Number($("search-subject").value)];
  if (!group) {
    status.textContent = "科目を選んでください。";
    return;
  }
  // 選択科目は第１問・第２問の両方を対象にするので、カードに科目名も出す
  const showSubject = group.subjects.length > 1;
  const token = ++searchToken;
  status.textContent = `「${group.label}」を検索中…`;

  try {
    const { hits, searchedYears, missingYears } = await searchSubject({
      yobi,
      subjects: group.subjects,
      types,
      query,
    });
    if (token !== searchToken) return; // 新しい検索が始まっていたら捨てる

    if (!hits.length) {
      status.textContent =
        `「${query}」は ${group.label} の${searchedYears}年度分から見つかりませんでした。` +
        (missingYears.length
          ? `（変換データが無い${missingYears.length}年度は対象外）`
          : "");
      return;
    }
    status.textContent =
      `「${query}」: ${hits.length}件（${searchedYears}年度分を検索）` +
      (missingYears.length
        ? `。変換データが無い${missingYears.length}年度は対象外です。`
        : "");
    for (const hit of hits) {
      results.appendChild(
        buildHitCard(hit, showSubject, (h) => applySearchHit(h, yobi)),
      );
    }
  } catch (e) {
    if (token !== searchToken) return;
    status.textContent = `検索に失敗しました: ${e.message}`;
  }
}

// カードの内容を画面の選択欄へ反映する（選択科目はヒットした問の方を選ぶ）。
// ダイアログで試験を切り替えて検索していた場合は、メイン画面もそちらに合わせる。
function applySearchHit(hit, yobi) {
  if (isYobi() !== yobi) {
    const radio = document.querySelector(
      `input[name="exam"][value="${yobi ? "yobi" : "shihou"}"]`,
    );
    if (radio) {
      radio.checked = true;
      applyExamMode(); // 年度・科目・種類のリストを作り直す
    }
  }
  $("subject").value = hit.subject;
  $("year").value = hit.yearKey;
  setType(hit.docType);
  for (const id of ["year", "subject"]) {
    if ($(id)._cs) $(id)._cs.refresh();
  }
  refreshResult();
  closeSearch();
  showToast(`${hit.yearLabel} ${hit.subject} ${hit.docType} を選びました`);
}

// ─── 実行ボタン・変換コンテキスト ─────────────────────────────────────────
// 状態表示（#status）とボタン内の進捗は ui.js が担う。処理中は次のボタンを
// すべて無効化する。
setActionButtons(["save-pdf", "save-zip", "save-llm", "run"]);

const ctxOf = (setProgress) => ({ log: () => {}, setProgress });
// 複数種類を並列に処理するときは、個々の進捗を出さない（完了件数で集約する）
const QUIET_CTX = ctxOf(() => {});

// ─── テキストの表示 ───────────────────────────────────────────────────────
// 年度・科目・種類・出力形式を選んだ時点で、事前変換データ（または処理済み
// キャッシュ）からテキストを表示する。原典PDFの取得・解析は自動では行わず、
// 変換データが無いときだけ「原典PDFから変換する」ボタンを出す。
let lastResult = "";
// 表示中テキストの .txt 保存ファイル名（司法・予備で命名が異なるため保持）。
let lastTxtName = "";
let refreshToken = 0; // 連続した選択変更で古い結果を表示しないための世代番号

function selectedFormat() {
  const el = document.querySelector('input[name="format"]:checked');
  return el ? el.value : "plain";
}

function currentYearLabel() {
  return yearKeyToLabel($("year").value);
}

function currentSelection() {
  return {
    yobi: isYobi(),
    yearKey: $("year").value,
    subject: $("subject").value,
    docType: currentType(),
    decorate: selectedFormat() === "scrapbox",
  };
}

// 法務省が公表していない・まだ公表していない組合せは、ボタンを出さずに理由を示す
function unavailableReason({ yobi, yearKey, subject, docType }) {
  if (yobi) {
    if (docType === "出題の趣旨" && !YOBI_RONBUN_DEF[subject]?.sHeaders)
      return {
        title: `${subject}の出題の趣旨は公表されていません`,
        text: "法務省はこの科目の出題の趣旨を公表していません。試験問題は表示・保存できます。",
      };
    return null;
  }
  if (docType !== "試験問題" && !(yearKey in RESULTS_URL_MAP))
    return {
      title: `${yearKeyToLabel(yearKey)}の${docType}はまだ公表されていません`,
      text: "出題の趣旨・採点実感は例年9〜11月頃に公表されます。法務省ウェブに掲載されると、1週間以内に自動で追加されます。",
    };
  return null;
}

function resetResultActions() {
  lastResult = "";
  lastTxtName = "";
  $("copy").disabled = true;
  $("download").disabled = true;
  $("result-src").hidden = true;
  $("result-src").removeAttribute("href");
}

function showResultMessage(title, text, withRun) {
  resetResultActions();
  $("result").textContent = "";
  $("result").hidden = true;
  $("result-message-title").textContent = title;
  $("result-message-text").textContent = text;
  $("run").hidden = !withRun;
  $("result-message").hidden = false;
}

function showResultText(r, sel) {
  const { yobi, subject, docType, decorate } = sel;
  lastResult = r.result;
  const formatSuffix = decorate ? "（scrapbox記法）" : "";
  const examLabel = yobi ? "司法試験予備試験論文式" : "司法試験";
  lastTxtName = `${yearKeyToLabel(sel.yearKey)}${examLabel}${subject}${docType}${formatSuffix}.txt`;
  $("result-message").hidden = true;
  $("result").hidden = false;
  $("result").classList.remove("stale");
  $("result").textContent = r.result;
  $("copy").disabled = false;
  $("download").disabled = false;
  if (r.pdfUrl) {
    $("result-src").href = r.pdfUrl;
    $("result-src").hidden = false;
  }
}

async function refreshResult() {
  const token = ++refreshToken;
  const sel = currentSelection();
  const { yobi, yearKey, subject, docType, decorate } = sel;
  $("result-title").textContent = `${yearKeyToLabel(yearKey)} ${yobi ? "予備試験" : "司法試験"} ${subject} ${docType}`;
  // 読み込みの間は前のテキストを薄く残し、ちらつきを抑える
  $("result").classList.add("stale");
  resetResultActions();

  const reason = unavailableReason(sel);
  if (reason) return showResultMessage(reason.title, reason.text, false);

  try {
    const args = { yearKey, subject, docType, decorate, cachedOnly: true };
    const r = yobi
      ? await convertYobiText(args, QUIET_CTX)
      : await convertText(args, QUIET_CTX);
    if (token !== refreshToken) return; // 新しい選択が来ていたら捨てる
    if (!r) {
      showResultMessage(
        "この資料はまだ変換データがありません",
        (docType === "試験問題"
          ? ""
          : "出題の趣旨・採点実感は例年9〜11月頃に公表されるため、まだ公表されていない可能性もあります。") +
          "法務省ウェブに掲載済みなら、原典PDFをブラウザ内で解析してテキストにできます（数十秒かかることがあります）。PDFで保存するだけなら、上の「ファイルで保存」をそのまま押せます。",
        true,
      );
      return;
    }
    showResultText(r, sel);
  } catch (e) {
    if (token !== refreshToken) return;
    showResultMessage("テキストを表示できませんでした", e.message, false);
  }
}

// 変換データが無いときの「原典PDFから変換する」。処理結果はキャッシュされる
// ので、完了後に refreshResult() で表示する（他の保存処理とも共有される）。
async function onRun() {
  const sel = currentSelection();
  const { yobi, yearKey, subject, docType, decorate } = sel;
  const busy = startBusy("run", "変換中");
  clearStatus();
  let ok = false;
  try {
    // 司法は convertText、予備は convertYobiText（科目グループPDFから切り出し）。
    const args = { yearKey, subject, docType, decorate };
    if (yobi) await convertYobiText(args, ctxOf(busy.progress));
    else await convertText(args, ctxOf(busy.progress));
    ok = true;
  } catch (e) {
    // 予備の画像化PDF等は「失敗」ではなく案内（PDF保存を促す）として警告表示。
    setStatus(e.message, yobi ? "warn" : "error");
    alarmError(
      yobi ? "変換できませんでした" : "エラー",
      e.message,
      yobi ? "#d97706" : "#dc2626",
    );
  } finally {
    busy.done();
  }
  if (ok) {
    await refreshResult();
    celebrate("変換完了", "テキストを表示しました");
  }
}

async function onCopy() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult);
    celebrate("コピー完了", "クリップボードにコピーしました");
    showToast("クリップボードにコピーしました");
  } catch (e) {
    setStatus(`コピーできませんでした: ${e.message}`, "error");
  }
}

function onDownload() {
  if (!lastResult) return;
  // 表示時に控えたファイル名（司法／予備で命名規則が異なる）を使う。
  const filename =
    lastTxtName || `${currentYearLabel()}テキスト.txt`;
  triggerDownload(
    new Blob([lastResult], { type: "text/plain;charset=utf-8" }),
    filename,
  );
  celebrate("TXTを保存", "ダウンロードフォルダに保存しました");
  showToast(`${filename} を保存しました`);
}

// ─── 原典PDF保存 ─────────────────────────────────────────────────────────
// 選択中の種類の原典PDF（該当ページのみ）を保存する。
// 取得・解析済み（抜粋PDF・一式zipで保存済み、事前変換データの無い年度で
// 原典PDFから変換済みなど）ならキャッシュを再利用し、未処理なら自動で取得する。
async function onSaveSourcePdf() {
  if (isYobi()) return onSaveYobiSingle(currentType());
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const docType = currentType();
  const busy = startBusy("save-pdf", "PDF作成中");
  clearStatus();
  let fallbackUrl = "";
  try {
    const { pdfUrl, pageRange, pdfBytes } = await runConversion(
      { yearKey, subject, docType, decorate: false },
      ctxOf(busy.progress),
    );
    fallbackUrl = pdfUrl;
    const baseName = `${currentYearLabel()}司法試験${subject}${docType}`;
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    const { bytes } = await buildStampedPdf(
      pdfBytes,
      pageRange,
      baseName,
      sourceUrls,
    );
    triggerDownload(
      new Blob([bytes], { type: "application/pdf" }),
      `${baseName}.pdf`,
    );
    celebrate("PDFを保存", "原典から該当ページを抜き出しました");
    showToast("該当ページをPDFで保存しました");
  } catch (e) {
    setStatus(
      `抜粋PDFを作成できませんでした: ${e.message}` +
        (fallbackUrl ? "（元のPDFを新しいタブで開きます）" : ""),
      "error",
    );
    if (fallbackUrl) window.open(fallbackUrl, "_blank", "noopener");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

// 試験問題・出題の趣旨・採点実感の3点を取得して zip で一括保存する
async function onSaveSourceZip() {
  if (isYobi()) return onSaveYobiZip();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  const busy = startBusy("save-zip", "zip作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    // zip 内は「[年度]司法試験[科目名]一式」フォルダにまとめる
    const folder = `${yearLabel}司法試験${subject}一式`;
    // フッターのリンク用に3種類のURLを先に1回だけ解決して共有する
    const sourceUrls = await resolveSourceUrls(yearKey, subject);
    busy.progress(0.15);
    const docTypes = ["試験問題", "出題の趣旨", "採点実感"];
    const files = {};
    let done = 0;
    // 3種類を並列に取得・整形する（失敗は種類ごとに隔離）
    await Promise.allSettled(
      docTypes.map(async (docType) => {
        try {
          const { pageRange, pdfBytes } = await runConversion(
            { yearKey, subject, docType, decorate: false },
            QUIET_CTX,
          );
          const baseName = `${yearLabel}司法試験${subject}${docType}`;
          const { bytes } = await buildStampedPdf(
            pdfBytes,
            pageRange,
            baseName,
            sourceUrls,
          );
          files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
        } catch (e) {
          addNote(`${docType}は取得できませんでした（${e.message}）`);
        } finally {
          busy.progress(0.15 + 0.8 * (++done / docTypes.length));
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
    busy.progress(1.0);
    celebrate("zipを保存", "3点の抜粋PDFをまとめました");
    showToast("一式zipを保存しました");
  } catch (e) {
    setStatus(`一式zipを作成できませんでした: ${e.message}`, "error");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

// 試験問題・出題の趣旨・採点実感を1つの Markdown にまとめて保存する。
// LLM が文脈を把握できるよう、冒頭にメタ情報と出典を付ける。テキストだけで
// 作るので、テキスト変換と同じく事前変換データを優先する（convertText）。
async function onSaveLlm() {
  if (isYobi()) return onSaveYobiLlm();
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  const busy = startBusy("save-llm", "作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    const docTypes = ["試験問題", "出題の趣旨", "採点実感"];
    const byType = {}; // docType → { body, subjectLabel }
    const sourceUrls = {};
    let done = 0;
    // 3種類を並列取得（完了順は不定なので docType をキーに集約し、出力は固定順）
    await Promise.allSettled(
      docTypes.map(async (docType) => {
        try {
          const { result, pdfUrl, subjectLabel } = await convertText(
            { yearKey, subject, docType, decorate: false },
            QUIET_CTX,
          );
          // 変換結果の1行目（タイトル）と2行目（出典）を除き本文だけ取り出す
          const body = result.split("\n").slice(2).join("\n").trim();
          byType[docType] = { body, subjectLabel };
          if (pdfUrl) sourceUrls[docType] = pdfUrl;
        } catch (e) {
          addNote(`${docType}は取得できませんでした（${e.message}）`);
        } finally {
          busy.progress(0.05 + 0.9 * (++done / docTypes.length));
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
    busy.progress(1.0);
    celebrate("Markdownを保存", "LLMに渡せる1ファイルを作成しました");
    showToast("LLM用Markdownを保存しました");
  } catch (e) {
    setStatus(`LLM用ファイルを作成できませんでした: ${e.message}`, "error");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

// ─── 予備試験モードの保存処理 ─────────────────────────────────────────────
// 画面・テキスト表示は司法と共通（refreshResult・onRun が convertYobiText を
// 呼ぶ）。ここでは「ファイルで保存」（抜粋PDF・一式zip・LLM用）の予備版を担う。原典は
// 試験問題（科目グループ別）と出題の趣旨（全科目まとめた1PDF）から当該科目を
// 切り出し、出典フッター・左上見出し付きで保存する。採点実感は予備に無い。
const YOBI_DOC_TYPES = ["試験問題", "出題の趣旨"];

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
  const pdfBytes = await fetchPdf(pdfUrl);

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
        addNote(`「${subject}」の区分を特定できず、グループ全体を保存します（画像PDF等の可能性）。`);
      } else {
        pageRange = null; // 趣旨は全科目をそのまま
        addNote(`「${subject}」の区分を特定できず、出題の趣旨は全体（全科目）を保存します（画像PDF等の可能性）。`);
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
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const busy = startBusy("save-pdf", "PDF作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    const sourceUrls = await resolveYobiSourceUrls(yearKey, subject);
    busy.progress(0.4);
    const { bytes, baseName, savedPages } = await buildYobiPdf(
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
    setStatus(`抜粋PDFを作成できませんでした: ${e.message}`, "error");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

async function onSaveYobiZip() {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  const busy = startBusy("save-zip", "zip作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    const folder = `${yearLabel}司法試験予備試験論文式${subject}一式`;
    const sourceUrls = await resolveYobiSourceUrls(yearKey, subject);
    busy.progress(0.3);
    const files = {};
    let done = 0;
    // 試験問題・出題の趣旨を並列に取得・整形する（失敗は種類ごとに隔離）
    await Promise.allSettled(
      YOBI_DOC_TYPES.map(async (docType) => {
        try {
          const { bytes, baseName } = await buildYobiPdf(
            yearKey,
            subject,
            docType,
            sourceUrls,
          );
          files[`${folder}/${baseName}.pdf`] = new Uint8Array(bytes);
        } catch (e) {
          addNote(`${docType}は取得できませんでした（${e.message}）`);
        } finally {
          busy.progress(0.3 + 0.6 * (++done / YOBI_DOC_TYPES.length));
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
    busy.progress(1.0);
    celebrate("zipを保存", "問題＋趣旨をまとめました");
    showToast("zipを保存しました");
  } catch (e) {
    setStatus(`一式zipを作成できませんでした: ${e.message}`, "error");
    alarmError("エラー", e.message);
  } finally {
    busy.done();
  }
}

// 予備：試験問題・出題の趣旨をテキスト化し、1つの Markdown にまとめて保存する
// （司法の onSaveLlm の予備版。採点実感は無いので2種類）。画像化PDF等で変換
// できない種類は警告して除外する。
async function onSaveYobiLlm() {
  const yearKey = $("year").value;
  const subject = $("subject").value;
  const yearLabel = currentYearLabel();
  const busy = startBusy("save-llm", "作成中");
  clearStatus();
  busy.progress(0.05);
  try {
    const byType = {}; // docType → body
    const sourceUrls = {};
    let done = 0;
    await Promise.allSettled(
      YOBI_DOC_TYPES.map(async (docType) => {
        try {
          const { result, pdfUrl } = await convertYobiText(
            { yearKey, subject, docType, decorate: false },
            QUIET_CTX,
          );
          // 1行目（タイトル）・2行目（出典）を除いた本文だけ取り出す
          byType[docType] = result.split("\n").slice(2).join("\n").trim();
          if (pdfUrl) sourceUrls[docType] = pdfUrl;
        } catch (e) {
          addNote(`${docType}は変換できませんでした（${e.message}）`);
        } finally {
          busy.progress(0.05 + 0.9 * (++done / YOBI_DOC_TYPES.length));
        }
      }),
    );

    const got = YOBI_DOC_TYPES.filter((d) => byType[d]);
    if (got.length === 0)
      throw new Error("いずれの種類も変換できませんでした。");

    const md = [];
    md.push(`# ${yearLabel}司法試験予備試験 論文式 ${subject}`);
    md.push("");
    md.push("> この文書は、日本の司法試験予備試験（司法試験の受験資格を得る");
    md.push("> ための国家試験）の論文式試験の過去問題と、その出題趣旨を");
    md.push("> まとめたものです。法律答案の作成・添削・解説の参考資料として");
    md.push("> 利用できます。");
    md.push("");
    md.push("## 書誌情報");
    md.push("");
    md.push(`- 試験: ${yearLabel}司法試験予備試験 論文式試験`);
    md.push(`- 科目: ${subject}`);
    md.push("- 出典: 法務省ウェブサイト（原典PDFを加工して作成）");
    for (const docType of YOBI_DOC_TYPES) {
      if (sourceUrls[docType]) md.push(`  - ${docType}: ${sourceUrls[docType]}`);
    }
    md.push("");
    md.push("※ PDFからの自動抽出のため、原文と細部が異なる場合があります。");
    md.push("");
    for (const docType of YOBI_DOC_TYPES) {
      if (!byType[docType]) continue;
      md.push(`## ${docType}`);
      md.push("");
      md.push(byType[docType]);
      md.push("");
    }

    const filename = `${yearLabel}司法試験予備試験論文式${subject}_LLM用.md`;
    triggerDownload(
      new Blob([md.join("\n")], { type: "text/markdown;charset=utf-8" }),
      filename,
    );
    busy.progress(1.0);
    celebrate("Markdownを保存", "LLMに渡せる1ファイルを作成しました");
    showToast("LLM用Markdownを保存しました");
  } catch (e) {
    setStatus(`LLM用ファイルを作成できませんでした: ${e.message}`, "error");
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
  initNewsBar(NEWS);
  // 選択（年度・科目・種類・出力形式）を変えたらテキストを表示し直す
  for (const id of ["year", "subject"]) {
    $(id).addEventListener("change", refreshResult);
  }
  $("type").addEventListener("change", refreshResult);
  for (const r of document.querySelectorAll('input[name="format"]')) {
    r.addEventListener("change", refreshResult);
  }
  for (const r of document.querySelectorAll('input[name="exam"]')) {
    r.addEventListener("change", applyExamMode);
  }
  // ボタンは司法・予備で共通。保存系ハンドラ内で isYobi() を見て分岐する。
  $("run").addEventListener("click", onRun);
  $("copy").addEventListener("click", onCopy);
  $("download").addEventListener("click", onDownload);
  $("save-pdf").addEventListener("click", onSaveSourcePdf);
  $("save-zip").addEventListener("click", onSaveSourceZip);
  $("save-llm").addEventListener("click", onSaveLlm);
  updateSavePills();
  refreshResult();

  // ダイアログ（ヘルプ・全文検索）。背景クリック・Escでも閉じる。
  setupDialog("help-dialog", "help", "help-close");
  enhanceSelect($("search-subject"), searchGroupColor);
  setupDialog("search-dialog", "search-open", "search-close", () => {
    initSearchControls();
    preloadSelectedSearch();
    $("search-input").focus();
  });
  for (const r of document.querySelectorAll('input[name="search-exam"]')) {
    r.addEventListener("change", () => {
      buildSearchSubjects(false);
      preloadSelectedSearch();
      $("search-results").innerHTML = "";
      $("search-status").textContent =
        "キーワードを入力して「検索」を押してください。";
    });
  }
  $("search-subject").addEventListener("change", preloadSelectedSearch);
  $("search-run").addEventListener("click", onSearch);
  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSearch();
  });
});
