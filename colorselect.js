// =============================================================================
// カスタムドロップダウン（全プルダウン共通の見た目）
//
// macOS のネイティブ <select> は、開いたリストの各 <option> に背景色を反映
// しない（OS のネイティブ描画が使われるため）。また見た目を全プルダウンで
// 揃えるため、年度・科目・種類いずれも native <select> を「値の保持先」として
// 残したまま見た目を独自実装のドロップダウンに置き換える。選択時には native
// select に値を反映して change を発火するので、値を読む既存処理
// （$("subject").value など）や change リスナーはそのまま動く。
//
// colorOf(value) を渡すと各項目をその色で塗り分ける（科目の系統色用）。省略
// すると無地（年度・種類）。リストが作り直される場合は再構築後に refresh()。
// =============================================================================

// native <select> をラップしてカスタムドロップダウンを構築する。
// colorOf は値→CSS色を返す任意の関数（falsy なら無地）。
// 戻り値（controller）は select._cs にも保存し、refresh() で再同期できる。
export function enhanceSelect(select, colorOf) {
  const tint = (el, value) => {
    el.style.backgroundColor = (colorOf && colorOf(value)) || "";
  };

  const wrap = document.createElement("div");
  wrap.className = "cs";
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("cs-native"); // CSS で視覚的に隠す（値は保持）

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.id = `${select.id}-trigger`;
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const labelSpan = document.createElement("span");
  labelSpan.className = "cs-label";
  trigger.appendChild(labelSpan);

  const list = document.createElement("ul");
  list.className = "cs-list";
  list.id = `${select.id}-listbox`;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  trigger.setAttribute("aria-controls", list.id);

  // 既存の <label for="subject"> を読み上げ名に流用する
  const labelEl = document.querySelector(`label[for="${select.id}"]`);
  if (labelEl) {
    if (!labelEl.id) labelEl.id = `${select.id}-label`;
    trigger.setAttribute("aria-labelledby", `${labelEl.id} ${trigger.id}`);
    list.setAttribute("aria-labelledby", labelEl.id);
  }

  wrap.appendChild(trigger);
  wrap.appendChild(list);

  let activeIndex = -1;

  // 型打ち検索（ネイティブ select と同様の先頭一致ジャンプ）の状態
  let typeBuf = "";
  let typeTimer = 0;

  function buildList() {
    list.innerHTML = "";
    [...select.options].forEach((opt, i) => {
      const li = document.createElement("li");
      li.className = "cs-option";
      li.id = `${select.id}-opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === select.selectedIndex));
      li.textContent = opt.textContent;
      tint(li, opt.value);
      li.addEventListener("click", () => choose(i));
      li.addEventListener("mousemove", () => setActive(i));
      list.appendChild(li);
    });
  }

  function syncTrigger() {
    const opt = select.options[select.selectedIndex];
    labelSpan.textContent = opt ? opt.textContent : "";
    tint(trigger, opt ? opt.value : "");
  }

  function setActive(i) {
    const items = list.children;
    if (items[activeIndex]) items[activeIndex].classList.remove("active");
    activeIndex = i;
    const cur = items[i];
    if (cur) {
      cur.classList.add("active");
      // フォーカスを保持する trigger 側に付けないと支援技術に伝わらない
      trigger.setAttribute("aria-activedescendant", cur.id);
      cur.scrollIntoView({ block: "nearest" });
    }
  }

  function open() {
    if (!list.hidden) return;
    buildList();
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    setActive(select.selectedIndex >= 0 ? select.selectedIndex : 0);
    document.addEventListener("click", onDocClick, true);
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    document.removeEventListener("click", onDocClick, true);
  }

  function choose(i) {
    if (i < 0 || i >= select.options.length) return;
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    syncTrigger();
    close();
    trigger.focus();
  }

  function onDocClick(e) {
    if (!wrap.contains(e.target)) close();
  }

  trigger.addEventListener("click", () => (list.hidden ? open() : close()));
  trigger.addEventListener("keydown", (e) => {
    const last = select.options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        list.hidden ? open() : setActive(Math.min(activeIndex + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        list.hidden ? open() : setActive(Math.max(activeIndex - 1, 0));
        break;
      case "Home":
        if (!list.hidden) { e.preventDefault(); setActive(0); }
        break;
      case "End":
        if (!list.hidden) { e.preventDefault(); setActive(last); }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        list.hidden ? open() : choose(activeIndex);
        break;
      case "Escape":
        close();
        break;
      case "Tab":
        close();
        break;
      default: {
        // 型打ち検索: 印字文字で先頭一致の項目へ移動（同じ文字の連打は順送り）
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) break;
        e.preventDefault();
        clearTimeout(typeTimer);
        typeTimer = setTimeout(() => (typeBuf = ""), 700);
        const sameChar =
          typeBuf.length > 0 && [...typeBuf].every((c) => c === e.key);
        typeBuf += e.key;
        const query = sameChar ? e.key : typeBuf;
        const opts = [...select.options];
        const from = list.hidden ? select.selectedIndex : activeIndex;
        const startStep = sameChar || query.length === 1 ? 1 : 0;
        for (let step = startStep; step <= opts.length; step++) {
          const i = (from + step + opts.length) % opts.length;
          if (opts[i].textContent.trim().startsWith(query)) {
            if (list.hidden) open();
            setActive(i);
            break;
          }
        }
        break;
      }
    }
  });

  syncTrigger();

  const controller = {
    // 科目リスト再構築後の再同期（開いていればリストも作り直す）
    refresh() {
      syncTrigger();
      if (!list.hidden) buildList();
    },
  };
  select._cs = controller;
  return controller;
}
