// しほしけコンバーター 動作説明動画の収録スクリプト（Playwright）
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// playwright はグローバル導入でもローカル導入でも拾えるようにする
// （PLAYWRIGHT_PATH で明示指定も可）。
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = process.env.DEMO_BASE_URL || 'http://127.0.0.1:8099';
const OUT = path.join(HERE, 'raw');
const W = 1280, H = 800;

const FONTS = {
  'nsjp-400': 'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff2',
  'nsjp-500': 'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-500-normal.woff2',
  'nsjp-700': 'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-700-normal.woff2',
  'zkgn-500': 'node_modules/@fontsource/zen-kaku-gothic-new/files/zen-kaku-gothic-new-japanese-500-normal.woff2',
  'zkgn-700': 'node_modules/@fontsource/zen-kaku-gothic-new/files/zen-kaku-gothic-new-japanese-700-normal.woff2',
};
const FONT_CSS = `
@font-face{font-family:'Noto Sans JP';font-style:normal;font-weight:400;font-display:block;src:url(https://fonts.gstatic.com/demo/nsjp-400.woff2) format('woff2');}
@font-face{font-family:'Noto Sans JP';font-style:normal;font-weight:500;font-display:block;src:url(https://fonts.gstatic.com/demo/nsjp-500.woff2) format('woff2');}
@font-face{font-family:'Noto Sans JP';font-style:normal;font-weight:700;font-display:block;src:url(https://fonts.gstatic.com/demo/nsjp-700.woff2) format('woff2');}
@font-face{font-family:'Zen Kaku Gothic New';font-style:normal;font-weight:500;font-display:block;src:url(https://fonts.gstatic.com/demo/zkgn-500.woff2) format('woff2');}
@font-face{font-family:'Zen Kaku Gothic New';font-style:normal;font-weight:700;font-display:block;src:url(https://fonts.gstatic.com/demo/zkgn-700.woff2) format('woff2');}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1', '--hide-scrollbars'] });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });

  // Google Fonts はこの収録環境から届かないので、同じ URL のまま
  // npm 由来の同一書体をローカルから返す（CSP と整合させるため URL は変えない）。
  await ctx.route('https://fonts.googleapis.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: FONT_CSS }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => {
    const key = path.basename(new URL(r.request().url()).pathname, '.woff2');
    const f = FONTS[key];
    if (!f) return r.abort();
    return r.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(path.join(HERE, f)) });
  });

  await ctx.addInitScript({ content: readFileSync(path.join(HERE, 'overlay.js'), 'utf8') });

  const page = await ctx.newPage();
  const D = new Director(page);
  await D.run();

  await ctx.close();
  await browser.close();
  console.log('done');
}

class Director {
  constructor(page) { this.page = page; }

  ui(fn, ...args) { return this.page.evaluate(fn, ...args); }

  async say(title, body, note, pos) {
    await this.page.evaluate(([t, b, n, p]) => window.__demo.caption(t, b, n, p), [title, body, note || '', pos || '']);
  }
  async unsay() { await this.page.evaluate(() => window.__demo.hideCaption()); }
  async step(t) { await this.page.evaluate((s) => window.__demo.step(s), t); }
  async cursor(on = true) { await this.page.evaluate((v) => window.__demo.showCursor(v), on); }

  async moveTo(sel, ms = 700, dx = 0, dy = 0) {
    const box = await this.page.locator(sel).first().boundingBox();
    if (!box) throw new Error('no box: ' + sel);
    const x = box.x + box.width / 2 + dx, y = box.y + box.height / 2 + dy;
    await this.page.evaluate(([x, y, ms]) => window.__demo.moveTo(x, y, ms), [x, y, ms]);
    await sleep(ms + 120);
    return { x, y };
  }

  async click(sel, opts = {}) {
    const { pre = 700, post = 700, dx = 0, dy = 0 } = opts;
    await this.moveTo(sel, pre, dx, dy);
    await this.page.evaluate(() => window.__demo.pop());
    await sleep(180);
    await this.page.locator(sel).first().click({ force: true });
    await sleep(Math.min(post, 350));
    // ダイアログの開閉でオーバーレイの置き場所が変わるので追従させる
    await this.page.evaluate(() => window.__demo.sync());
    await sleep(Math.max(0, post - 350));
  }

  async spot(sel, pad = 10) {
    if (!sel) { await this.page.evaluate(() => window.__demo.spot(null)); return; }
    const box = await this.page.locator(sel).first().boundingBox();
    await this.page.evaluate(([b, p]) => window.__demo.spot(b, p), [box, pad]);
  }

  async typeInto(sel, text, delay = 110) {
    await this.moveTo(sel, 600);
    await this.page.evaluate(() => window.__demo.pop());
    await this.page.locator(sel).first().click({ force: true });
    await sleep(250);
    await this.page.locator(sel).first().type(text, { delay });
    await sleep(400);
  }

  // ページを滑らかにスクロールする
  async glide(to, ms = 1400) {
    await this.page.evaluate(([to, ms]) => new Promise((res) => {
      const from = window.scrollY;
      const t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        window.scrollTo(0, from + (to - from) * e);
        k < 1 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    }), [to, ms]);
    await sleep(150);
  }

  async glideIn(sel, ms = 1200, container = null) {
    const box = await this.page.locator(sel).first().boundingBox();
    if (!container) {
      const y = await this.page.evaluate(() => window.scrollY);
      await this.glide(Math.max(0, y + box.y - 180), ms);
    }
  }

  // ダイアログ内のスクロール
  async glideEl(sel, to, ms = 1400) {
    await this.page.evaluate(([sel, to, ms]) => new Promise((res) => {
      const el = document.querySelector(sel);
      const from = el.scrollTop, t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        el.scrollTop = from + (to - from) * e;
        k < 1 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    }), [sel, to, ms]);
    await sleep(150);
  }

  async card(badge, head, sub, lines, hold = 3600) {
    await this.page.evaluate(([b, h, s, l]) => window.__demo.card(b, h, s, l), [badge, head, sub, lines || []]);
    await sleep(hold);
  }
  async uncard() {
    await this.page.evaluate(() => window.__demo.hideCard());
    await sleep(600);
  }

  // 独自ドロップダウン（colorselect.js）を開いて項目を選ぶ
  async pick(id, label, opts = {}) {
    const { hold = 900, scrollTo = null } = opts;
    await this.click(`#${id}-trigger`, { post: 500 });
    if (scrollTo != null) {
      await this.glideEl(`#${id}-listbox`, scrollTo, 900);
      await sleep(400);
    }
    await sleep(hold);
    const li = `#${id}-listbox li:text-is("${label}")`;
    await this.click(li, { pre: 600, post: 800 });
  }

  async run() {
    const p = this.page;

    // ---------- 0. タイトル ----------
    await p.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2500); // フォント読み込み待ち
    await p.evaluate(() => window.scrollTo(0, 0));
    await this.card(
      'DEMO',
      'しほしけコンバーター（β版）',
      '司法試験・予備試験 論文式の過去問を\n法務省公表PDFからテキスト化するWebアプリ',
      ['動作説明（画面収録）'],
      4200,
    );
    await this.uncard();

    // ---------- 1. トップ画面 ----------
    await this.step('1 / 8　トップ画面');
    await this.cursor(true);
    await this.say(
      'このアプリについて',
      '法務省が公表する「試験問題」「出題の趣旨」「採点実感」のPDFを、ブラウザの中だけでテキストに変換します。',
      'サーバーは無く、登録も不要。処理も保存もすべて手元のブラウザで完結します。',
    );
    await sleep(5200);
    await this.unsay();

    await this.say('更新情報', '毎週月曜にGitHub Actionsが法務省サイトを巡回し、新年度の掲載を検出すると年度リストと更新情報を自動で追加します。');
    await this.spot('.news', 8);
    await sleep(4600);
    await this.spot(null);
    await this.unsay();

    // ---------- 2. ヘルプ ----------
    await this.step('2 / 8　使い方・FAQ');
    await this.say('使い方・FAQ', '画面右上の「使い方・FAQ」に、対応年度・科目や出典表示など、よくある質問をまとめてあります。');
    await sleep(2400);
    await this.click('#help', { post: 1100 });
    await this.unsay();
    await sleep(1200);
    await this.glideEl('#help-dialog', 380, 1400);
    await sleep(1400);
    await this.click('#help-dialog details:nth-of-type(4) summary', { pre: 600, post: 1200 });
    await sleep(2600);
    await this.glideEl('#help-dialog', 0, 900);
    await this.click('#help-close', { post: 900 });

    // ---------- 3. 選択欄 ----------
    await this.step('3 / 8　年度・科目・種類を選ぶ');
    await this.glide(0, 600);
    await this.say('①　まず4つを選ぶ', '「試験」「年度」「科目」「種類」を選ぶだけ。これがすべての操作の起点です。');
    await this.spot('.form', 8);
    await sleep(3800);
    await this.spot(null);
    await this.unsay();

    await this.say('年度', '司法試験は平成22年から最新年度まで。新年度は自動巡回で追加されます。', '', 'top');
    await this.pick('year', '令和6年(2024年)', { hold: 1500 });
    await this.unsay();

    await this.say('科目', '基本7科目と選択科目8科目（各第１問・第２問）。系統ごとに色分けされています。', '', 'top');
    await this.click('#subject-trigger', { post: 600 });
    await sleep(1400);
    await this.glideEl('#subject-listbox', 430, 1600);
    await sleep(1500);
    await this.click('#subject-listbox li:text-is("労働法第１問")', { pre: 700, post: 900 });
    await sleep(800);
    await this.unsay();

    await this.say('種類', '「試験問題」「出題の趣旨」「採点実感」の3種類から選びます。趣旨・実感は例年9〜11月頃に公表されます。');
    await this.spot('#type-field', 8);
    await sleep(2400);
    await this.click('#type .seg-item:nth-child(2)', { post: 1000 });
    await sleep(1400);
    await this.spot(null);
    await this.unsay();

    // ---------- 4. テキストに変換 ----------
    await this.step('4 / 8　テキストに変換');
    await this.glide(240, 900);
    await this.say('②-A　テキストに変換', 'メイン機能。原典PDFを取得して段落構造を復元し、読めるテキストに整形します。');
    await this.spot('.lane-convert', 8);
    await sleep(4200);
    await this.spot(null);

    await this.say('出力形式', 'そのまま読む「ノーマル」と、見出し記法とタグが付く「Scrapbox記法」を選べます。');
    await this.click('.lane-convert .seg-item:nth-child(2)', { post: 1200 });
    await sleep(1800);
    await this.click('.lane-convert .seg-item:nth-child(1)', { post: 1000 });
    await this.unsay();

    await this.say(
      '変換実行',
      '「変換実行」を押すと、法務省ウェブからPDFを取得 → 解析 → 整形 まで自動で進み、結果は「結果をコピー」「.txt 保存」で持ち出せます。',
      '※ この収録環境は法務省ウェブへ接続できないため、実行そのものは収録していません。',
    );
    await this.spot('#run', 10);
    await sleep(6000);
    await this.spot(null);
    await this.unsay();

    // ---------- 5. そのまま保存 ----------
    await this.step('5 / 8　そのまま保存');
    await this.say('②-B　そのまま保存', 'テキストにせず、原典PDFのまま欲しいときはこちら。変換せずに押すだけで保存できます。');
    await this.spot('.lane-save', 8);
    await sleep(4000);
    await this.spot(null);
    await this.unsay();

    await this.say('個別', '選択中の種類の該当ページだけを原典PDFから抜き出し、各ページのフッターに出典と加工表示を印字して保存します。');
    await this.spot('#save-desc', 8);
    await sleep(4200);
    await this.unsay();
    await this.click('#save-mode .seg-item:nth-child(2)', { post: 700 });
    await this.say('一式', '試験問題・出題の趣旨・採点実感の3点の抜粋PDFを、1つのフォルダにまとめてzipで保存します。');
    await sleep(4200);
    await this.unsay();
    await this.click('#save-mode .seg-item:nth-child(3)', { post: 700 });
    await this.say('LLM', '3種類をメタ情報・出典付きの1つのMarkdownにまとめます。答案の添削や解説をLLMに頼むときの添付用です。');
    await sleep(4400);
    await this.spot(null);
    await this.unsay();
    await this.click('#save-mode .seg-item:nth-child(1)', { post: 600 });

    // ---------- 6. 予備試験 ----------
    await this.step('6 / 8　予備試験に切り替え');
    await this.glide(0, 800);
    await this.say('予備試験', '上部の「試験」で予備試験に切り替えると、年度・科目・種類がまとめて予備試験用に入れ替わります。');
    await sleep(2600);
    await this.click('.form .seg-item:nth-child(2)', { post: 1400 });
    await this.unsay();
    await this.say('科目が入れ替わる', '基本7科目に加えて法律実務基礎科目（民事・刑事）や選択科目。種類は試験問題と出題の趣旨の2つになります。', '', 'top');
    await this.click('#subject-trigger', { post: 600 });
    await sleep(1300);
    await this.glideEl('#subject-listbox', 150, 1300);
    await sleep(1500);
    await this.click('#subject-listbox li:text-is("法律実務基礎科目（民事）")', { pre: 700, post: 900 });
    await this.unsay();
    await this.say('科目グループPDFから自動で切り出す', '予備試験は「憲法・行政法」のように複数科目をまとめたPDFで公表されますが、選んだ科目だけを自動で切り出します。');
    await this.spot('#type-field', 8);
    await sleep(4600);
    await this.spot(null);
    await this.unsay();
    await this.click('.form .seg-item:nth-child(1)', { post: 1200 });

    // ---------- 7. 全文検索 ----------
    await this.step('7 / 8　全文検索');
    await this.say('全文検索', '「この論点は何年に出た？」を調べる機能。科目を選んでキーワードを入れると、全年度の本文から探します。');
    await sleep(3000);
    await this.click('#search-open', { post: 1200 });
    await this.unsay();
    await this.say('検索の仕組み', '検索は事前変換済みデータに対して行うので、法務省ウェブへのアクセスは発生しません。');
    await sleep(3600);
    await this.unsay();

    await this.pick('search-subject', '憲法', { hold: 1100 });
    await this.typeInto('#search-input', '表現の自由', 130);
    await this.click('#search-run', { post: 1600 });
    await p.waitForFunction(
      () => document.querySelectorAll('#search-results .hit-card').length > 0,
      null, { timeout: 30000 },
    );
    await sleep(900);
    await this.say('ヒットした年度がカードで並ぶ', '年度・種類・件数と、キーワード周辺の本文が抜粋で表示されます。');
    await sleep(3600);
    await this.unsay();
    await this.glideEl('#search-dialog', 620, 1800);
    await sleep(1800);
    await this.glideEl('#search-dialog', 300, 1000);
    await sleep(600);

    await this.say('カードを押すと選択欄に入る', 'その年度・科目・種類がそのまま画面の選択欄にセットされ、すぐ変換や保存に進めます。');
    await sleep(2600);
    await this.click('.hit-card >> nth=1', { pre: 800, post: 1600 });
    await this.unsay();
    await this.spot('.form', 8);
    await this.say('選択欄に反映された', '検索でヒットした年度・科目・種類が入っています。あとは「変換実行」または「保存実行」を押すだけです。');
    await sleep(4600);
    await this.spot(null);
    await this.unsay();

    // ---------- 8. 短答ダウンローダー ----------
    await this.step('8 / 8　しほしけ短答ダウンローダー');
    await this.say('姉妹ページ', '短答式は選択式でテキスト化に向かないため、原典PDFの保存に特化した別ページを用意しています。');
    await sleep(3000);
    await this.glide(0, 600);
    await this.click('.hero a[href="./tantou.html"]', { post: 1200 });
    await p.waitForLoadState('domcontentloaded');
    await p.waitForTimeout(900);
    await this.step('8 / 8　しほしけ短答ダウンローダー');
    await this.cursor(true);
    await sleep(1200);
    await this.say('しほしけ短答ダウンローダー', '短答式の「問題」と「正答及び配点」を、年度別・科目別に保存します。対象は憲法・民法・刑法の3科目です。');
    await sleep(4600);
    await this.unsay();
    await this.pick('subject', '民法', { hold: 900 });
    await this.say('3通りの保存', '問題PDF単体・正答及び配点PDF単体・両方をまとめたzip。いずれも全ページに出典と加工表示のフッターが入ります。');
    await this.spot('.save-card', 8);
    await sleep(4800);
    await this.spot(null);
    await this.unsay();

    // ---------- クロージング ----------
    await this.cursor(false);
    await this.step('');
    await sleep(400);
    await this.card(
      'しほしけコンバーター（β版）',
      'ブラウザだけで完結',
      '出力には公共データ利用規約（PDL1.0）に基づく\n「出典：法務省ウェブサイトを加工して作成」が自動で付きます',
      [
        'adatchan.github.io/barexam-scrapbox-web/',
        '法務省非公式の個人開発ツールです',
      ],
      6000,
    );
    await sleep(1500);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
