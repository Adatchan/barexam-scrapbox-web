// =============================================================================
// 画面部品の共通処理（コンバーター app.js・短答ダウンローダー tantou.js で共有）
//
//   状態表示   #status に注意・エラーだけを1行で出す（ログ欄は無い）
//   ボタン進捗 押したボタンの中に進捗バーと % を出し、他の実行ボタンを止める
//   更新情報   最新1件を1行で出し、残りは「すべて見る」で開く
//   保存       Blob をファイルとしてダウンロードさせる
//   ダイアログ ヘルプ・全文検索の開閉（アニメーション付き）
//   検索結果   全文検索のヒットカード
// =============================================================================
import { WORKER_URL } from "./moj.js";

const $ = (id) => document.getElementById(id);

// ─── 状態表示 ─────────────────────────────────────────────────────────────
let notes = [];

export function setStatus(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status status-line" + (kind ? " " + kind : "");
}

export function clearStatus() {
  notes = [];
  setStatus("");
}

// 処理は続けられる注意（一部の種類を取得できなかった等）を積み上げて表示する
export function addNote(msg) {
  notes.push(msg);
  setStatus(notes.join(" / "), "warn");
}

// ─── ボタン内の進捗 ───────────────────────────────────────────────────────
// 処理中は actionIds のボタンをすべて無効化する（排他制御）
let actionIds = [];

export function setActionButtons(ids) {
  actionIds = ids;
}

export function setBusy(busy) {
  for (const id of actionIds) $(id).disabled = busy;
}

// ボタンを処理中表示にし、進捗（0〜1）をボタン内のバーと % で示す。
// ボタン内の .btn-save-label / .btn-run-label の文言を差し替える。
// 戻り値の progress を変換コンテキストに渡し、終わったら done() で戻す。
export function startBusy(id, busyLabel) {
  const btn = $(id);
  const label = btn.querySelector(".btn-save-label, .btn-run-label");
  const original = label.textContent;
  setBusy(true);
  btn.classList.add("busy");
  btn.setAttribute("aria-busy", "true");
  const progress = (frac) => {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    btn.style.setProperty("--p", `${pct}%`);
    label.textContent = `${busyLabel}… ${pct}%`;
  };
  progress(0);
  return {
    progress,
    done() {
      btn.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      btn.style.removeProperty("--p");
      label.textContent = original;
      setBusy(false);
    },
  };
}

// ─── 更新情報 ─────────────────────────────────────────────────────────────
// #news（details）の summary に最新1件、#news-list に2〜5件目を出す
export function initNewsBar(items) {
  const latest = $("news-latest");
  const list = $("news-list");
  if (!latest || !list || !items.length) {
    $("news")?.setAttribute("hidden", "");
    return;
  }
  const line = (item) => {
    const frag = document.createDocumentFragment();
    const date = document.createElement("span");
    date.className = "news-date";
    date.textContent = item.date;
    frag.append(date, document.createTextNode(item.text));
    return frag;
  };
  latest.appendChild(line(items[0]));
  const rest = items.slice(1, 5);
  for (const item of rest) {
    const li = document.createElement("li");
    li.appendChild(line(item));
    list.appendChild(li);
  }
  if (!rest.length) $("news").classList.add("news-single");
}

// ─── 保存 ─────────────────────────────────────────────────────────────────
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safari ではクリック直後の revoke でダウンロードが失敗することがある
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  countDownload(filename);
}

// ─── ダウンロード数の計測 ─────────────────────────────────────────────────
// 保存のたびに Worker（/hit）へ種類だけを送り、月間ダウンロード数を数える。
// 送るのは「ページ（論文/短答）・試験（司法/予備）・形式（拡張子）」の組だけで、
// ファイル名・年度・科目・端末を識別する情報は送らない（Worker も IP 等を保存しない）。
// 集計は Worker の /stats で見られる。公開先以外（ローカル開発等）では送らない。
const COUNT_HOST = "barexam.y-adachi.com";

export function downloadKind(filename, pathname = location.pathname) {
  const page = /tantou/.test(pathname) ? "tantou" : "ronbun";
  const exam = /予備試験/.test(filename) ? "yobi" : "shihou";
  const ext = (filename.match(/\.(pdf|zip|md|txt)$/i)?.[1] || "").toLowerCase();
  return ext ? `${page}-${exam}-${ext}` : null;
}

function countDownload(filename) {
  try {
    if (location.hostname !== COUNT_HOST) return;
    const kind = downloadKind(filename);
    if (!kind) return;
    // keepalive: 保存直後にタブを閉じても送信を完了させる。失敗は無視する
    // （計測の失敗で保存操作を妨げない）。
    fetch(`${WORKER_URL}/hit?k=${kind}`, {
      method: "POST",
      keepalive: true,
      cache: "no-store",
    }).catch(() => {});
  } catch {
    /* 計測は付随処理なので握りつぶす */
  }
}

// ─── ダイアログ（ヘルプ・全文検索で共通）─────────────────────────────────
// 閉じるときは開いたときと同じ経路を戻る（.closing のアニメーション完了後に
// close()。アニメーションが無効な環境でも保険のタイマーで必ず閉じる）。
export function closeDialog(dlg) {
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

export function setupDialog(dialogId, openId, closeId, onOpen) {
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

// ─── 全文検索のヒットカード ───────────────────────────────────────────────
// 1件分のカード。押すと onPick(hit) を呼ぶ（画面の選択欄へ反映して閉じる）。
//   showSubject:  科目名を出す（選択科目の第１問/第２問をまとめて検索したとき）
//   showQuestion: 一致箇所の設問番号を出す（短答式）
//   showDocType:  種類（試験問題・出題の趣旨など）を出す
export function buildHitCard(hit, opts, onPick) {
  const { showSubject = false, showQuestion = false, showDocType = true } =
    opts || {};
  const card = document.createElement("button");
  card.type = "button";
  card.className = "hit-card";

  const head = document.createElement("div");
  head.className = "hit-head";
  const tag = (cls, text) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    head.appendChild(el);
  };
  tag("hit-year", hit.yearLabel);
  if (showSubject) tag("hit-type hit-subject", hit.subject);
  if (showDocType) tag("hit-type", hit.docType);
  // 短答式は最初に一致した設問番号（件数が複数なら他の問にも一致している）
  if (showQuestion && hit.question)
    tag(
      "hit-type hit-question",
      hit.count > 1 ? `${hit.question}ほか` : hit.question,
    );
  tag("hit-count", `${hit.count}件`);

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

// ─── ヘルプ画像の拡大表示 ─────────────────────────────────────────────────
// ヘルプの画面図（.help-figure a）を押すと、別画面に移らずその場で拡大表示する。
// ヘルプ自体がダイアログなので、拡大用のダイアログを上に重ねる（showModal は
// 後から開いたものが最前面になる）。画像を押すと全体表示と原寸表示（スクロール
// できる）を切り替え、背景・閉じるボタン・Esc で閉じる。スマホでは全体表示だと
// 文字が小さいので、原寸表示で細部を見られるようにする。
// JS が動かない環境ではリンク先（画像そのもの）が開く。
export function setupImageZoom(root = document) {
  const dlg = document.createElement("dialog");
  dlg.id = "zoom-dialog";
  dlg.setAttribute("aria-label", "画像の拡大表示");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "zoom-close";
  close.setAttribute("aria-label", "閉じる");
  close.textContent = "×";
  const img = document.createElement("img");
  img.className = "zoom-img";
  img.alt = "";
  const cap = document.createElement("p");
  cap.className = "zoom-caption";
  dlg.append(close, img, cap);
  document.body.appendChild(dlg);

  const hint = document.createElement("p");
  hint.className = "zoom-hint";
  hint.textContent = "画像を押すと原寸表示に切り替わります";
  dlg.append(hint);

  const setZoomed = (on) => {
    dlg.classList.toggle("zoomed", on);
    hint.textContent = on
      ? "画像を押すと全体表示に戻ります"
      : "画像を押すと原寸表示に切り替わります";
  };
  const hide = () => closeDialog(dlg);
  dlg.addEventListener("click", (e) => {
    if (e.target === img) setZoomed(!dlg.classList.contains("zoomed"));
    else if (e.target !== cap && e.target !== hint) hide(); // 背景・閉じるボタン
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault(); // Esc もアニメーションを通して閉じる（下のヘルプは開いたまま）
    hide();
  });

  root.addEventListener("click", (e) => {
    const link = e.target.closest(".help-figure a");
    if (!link) return;
    e.preventDefault();
    const src = link.querySelector("img");
    img.src = link.getAttribute("href");
    img.alt = src ? src.alt : "";
    cap.textContent =
      link.closest("figure")?.querySelector("figcaption")?.textContent || "";
    setZoomed(false);
    dlg.showModal();
    close.focus();
  });
}
