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
  if (showQuestion && hit.question) tag("hit-type hit-question", hit.question);
  tag(
    "hit-count",
    showQuestion && hit.question && hit.count > 1
      ? `${hit.question}ほか 計${hit.count}件`
      : `${hit.count}件`,
  );

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
