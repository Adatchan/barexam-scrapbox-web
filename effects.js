// =============================================================================
// 完了演出（軽量版）
//
// 各操作（変換・コピー・各種保存）の成功時に、中央へチェックマークのオーバー
// レイをふわっと出し、下部にトーストを出す。スタイル・キーフレームは style.css
// の .fx-* と @keyframes を参照。オーバーレイは pointer-events:none で操作を
// 妨げない（短時間で自動消滅）。app.js / tantou.js から呼び出す。
// =============================================================================
const ACCENT = "#1f5bd6";
let _ovTimer = 0;
let _toastTimer = 0;

// 成功時の完了オーバーレイ（リング＋チェック描画＋タイトル＋サブ文）。
export function celebrate(title, sub = "", color = ACCENT) {
  document.querySelector(".fx-overlay")?.remove();
  clearTimeout(_ovTimer);

  const ov = document.createElement("div");
  ov.className = "fx-overlay";

  const card = document.createElement("div");
  card.className = "fx-card";

  const icon = document.createElement("div");
  icon.className = "fx-icon";
  for (const cls of ["fx-ring", "fx-ring fx-ring2"]) {
    const r = document.createElement("span");
    r.className = cls;
    r.style.borderColor = color;
    icon.appendChild(r);
  }
  const disc = document.createElement("span");
  disc.className = "fx-disc";
  disc.style.background = color + "1a"; // 透過10%程度の淡い円
  disc.innerHTML =
    '<svg viewBox="0 0 24 24" width="38" height="38" fill="none" aria-hidden="true">' +
    `<path class="fx-check-path" d="M4 12.5l5 5L20 6" stroke="${color}" ` +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  icon.appendChild(disc);

  const t = document.createElement("div");
  t.className = "fx-title";
  t.textContent = title;
  const s = document.createElement("div");
  s.className = "fx-sub";
  s.textContent = sub;

  card.append(icon, t, s);
  ov.appendChild(card);
  document.body.appendChild(ov);
  _ovTimer = setTimeout(() => ov.remove(), 1500);
}

// 下部トースト（小さな確認メッセージ）。
export function showToast(text) {
  document.querySelector(".fx-toast")?.remove();
  clearTimeout(_toastTimer);

  const el = document.createElement("div");
  el.className = "fx-toast";
  const dot = document.createElement("span");
  dot.className = "fx-toast-dot";
  const sp = document.createElement("span");
  sp.textContent = text;
  el.append(dot, sp);
  document.body.appendChild(el);
  _toastTimer = setTimeout(() => el.remove(), 2000);
}
