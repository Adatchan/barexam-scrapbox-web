// =============================================================================
// 画面部品の共通処理（コンバーター app.js・短答ダウンローダー tantou.js で共有）
//
//   状態表示   #status に注意・エラーだけを1行で出す（ログ欄は無い）
//   ボタン進捗 押したボタンの中に進捗バーと % を出し、他の実行ボタンを止める
//   更新情報   最新1件を1行で出し、残りは「すべて見る」で開く
//   保存       Blob をファイルとしてダウンロードさせる
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
