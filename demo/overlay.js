// 動画収録用オーバーレイ（キャプション・疑似カーソル・タイトルカード）
// addInitScript で全ページに注入する。アプリ本体には一切触れない。
(() => {
  const CSS = `
  #dm-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none;
    font-family:"Zen Kaku Gothic New","Noto Sans JP",sans-serif;}
  #dm-cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(14px);
    max-width:1000px;min-width:420px;box-sizing:border-box;
    background:rgba(9,26,43,.94);color:#fff;border-radius:14px;
    padding:16px 26px;box-shadow:0 18px 48px rgba(0,0,0,.38);
    border:1px solid rgba(255,255,255,.14);
    opacity:0;transition:opacity .38s ease, transform .38s ease;}
  #dm-cap.on{opacity:1;transform:translateX(-50%) translateY(0);}
  #dm-cap.top{bottom:auto;top:74px;transform:translateX(-50%) translateY(-14px);}
  #dm-cap.top.on{transform:translateX(-50%) translateY(0);}
  #dm-cap .t{font-size:15px;font-weight:700;letter-spacing:.06em;color:#8fd0ff;margin-bottom:6px;}
  #dm-cap .b{font-size:21px;font-weight:500;line-height:1.55;}
  #dm-cap .n{margin-top:8px;font-size:15px;color:#c4d7e6;line-height:1.5;}
  #dm-step{position:fixed;left:26px;top:22px;background:rgba(9,26,43,.9);color:#fff;
    border-radius:999px;padding:7px 18px;font-size:15px;font-weight:700;letter-spacing:.05em;
    box-shadow:0 8px 22px rgba(0,0,0,.25);opacity:0;transition:opacity .3s ease;}
  #dm-step.on{opacity:1;}
  #dm-cur{position:fixed;left:0;top:0;width:26px;height:26px;opacity:0;
    transition:opacity .25s ease;will-change:transform;}
  #dm-cur svg{display:block;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45));}
  #dm-cur.on{opacity:1;}
  #dm-ring{position:fixed;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;
    border-radius:50%;background:rgba(0,116,196,.45);border:2px solid #0f9bff;opacity:0;}
  @keyframes dm-pop{0%{transform:scale(.35);opacity:.95}100%{transform:scale(3.6);opacity:0}}
  #dm-ring.go{animation:dm-pop .55s ease-out;}
  #dm-spot{position:fixed;border-radius:14px;pointer-events:none;opacity:0;
    box-shadow:0 0 0 3px #0f9bff, 0 0 0 9999px rgba(6,20,34,.52);
    transition:opacity .35s ease, all .45s cubic-bezier(.4,0,.2,1);}
  #dm-spot.on{opacity:1;}
  #dm-card{position:fixed;inset:0;background:linear-gradient(160deg,#04263f 0%,#0a4977 55%,#0b6ba8 100%);
    color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:18px;opacity:0;transition:opacity .5s ease;text-align:center;padding:0 60px;}
  #dm-card.on{opacity:1;}
  #dm-card .h{font-size:52px;font-weight:700;letter-spacing:.03em;}
  #dm-card .s{font-size:24px;font-weight:500;color:#bfe2ff;line-height:1.7;white-space:pre-line;}
  #dm-card .l{margin-top:10px;font-size:19px;color:#8fc4ea;line-height:1.8;}
  #dm-card .dm-badge{font-size:15px;letter-spacing:.22em;color:#7fb8e0;font-weight:700;background:none;padding:0;border-radius:0;}
  #dm-card .dm-badge:empty{display:none;}
  `;

  function build() {
    if (document.getElementById('dm-layer')) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    const layer = document.createElement('div');
    layer.id = 'dm-layer';
    layer.innerHTML = `
      <div id="dm-spot"></div>
      <div id="dm-step"></div>
      <div id="dm-cap"><div class="t"></div><div class="b"></div><div class="n"></div></div>
      <div id="dm-ring"></div>
      <div id="dm-cur"><svg width="26" height="26" viewBox="0 0 26 26">
        <path d="M3 2 L3 20.5 L8.2 15.6 L11.6 23.4 L15.1 21.9 L11.8 14.2 L19 14 Z"
              fill="#12283c" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
      <div id="dm-card"><div class="dm-badge"></div><div class="h"></div><div class="s"></div><div class="l"></div></div>`;
    document.body.appendChild(layer);

    const cur = layer.querySelector('#dm-cur');
    let cx = 640, cy = 420;
    cur.style.transform = `translate(${cx}px, ${cy}px)`;

    // <dialog> は top layer に描画され、通常の z-index では上に出せない。
    // ダイアログが開いている間はオーバーレイ自体をその中へ移して前面に保つ。
    function reparent() {
      const dlg = document.querySelector('dialog[open]');
      const host = dlg || document.body;
      if (layer.parentNode !== host) host.appendChild(layer);
    }

    window.__demo = {
      sync: reparent,
      caption(title, body, note, pos) {
        reparent();
        const c = document.getElementById('dm-cap');
        c.querySelector('.t').textContent = title || '';
        c.querySelector('.b').textContent = body || '';
        const n = c.querySelector('.n');
        n.textContent = note || '';
        n.style.display = note ? 'block' : 'none';
        c.classList.toggle('top', pos === 'top');
        c.classList.add('on');
      },
      hideCaption() { reparent(); document.getElementById('dm-cap').classList.remove('on'); },
      step(text) {
        reparent();
        const s = document.getElementById('dm-step');
        s.textContent = text || '';
        s.classList.toggle('on', !!text);
      },
      showCursor(on) { reparent(); cur.classList.toggle('on', on !== false); },
      moveTo(x, y, ms) {
        reparent();
        cur.style.transition = `transform ${ms}ms cubic-bezier(.3,.7,.3,1)`;
        cur.style.transform = `translate(${x}px, ${y}px)`;
        cx = x; cy = y;
      },
      pop() {
        reparent();
        const r = document.getElementById('dm-ring');
        r.style.left = cx + 'px';
        r.style.top = cy + 'px';
        r.classList.remove('go');
        void r.offsetWidth;
        r.classList.add('go');
      },
      spot(box, pad) {
        reparent();
        const s = document.getElementById('dm-spot');
        if (!box) { s.classList.remove('on'); return; }
        const p = pad == null ? 10 : pad;
        s.style.left = (box.x - p) + 'px';
        s.style.top = (box.y - p) + 'px';
        s.style.width = (box.width + p * 2) + 'px';
        s.style.height = (box.height + p * 2) + 'px';
        s.classList.add('on');
      },
      card(badge, head, sub, lines) {
        reparent();
        const c = document.getElementById('dm-card');
        c.querySelector('.dm-badge').textContent = badge || '';
        c.querySelector('.h').textContent = head || '';
        c.querySelector('.s').textContent = sub || '';
        c.querySelector('.l').innerHTML = (lines || []).join('<br>');
        c.classList.add('on');
      },
      hideCard() {
        sessionStorage.setItem('dm-started', '1');
        document.getElementById('dm-card').classList.remove('on');
      },
    };

    // 収録開始直後にアプリ本体が映り込まないよう、最初のページだけ
    // タイトルカードの下地を初期表示にしておく（文言は後から入れる）。
    if (!sessionStorage.getItem('dm-started')) {
      const c = document.getElementById('dm-card');
      c.style.transition = 'none';
      c.classList.add('on');
      requestAnimationFrame(() => { c.style.transition = ''; });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
