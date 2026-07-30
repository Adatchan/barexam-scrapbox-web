// =============================================================================
// テキスト構造の共有ルール
//
// PDF解析（parser.js）とテキスト整形（format.js）の双方から参照される
// 正規表現・判定関数を一元管理する。同じ構造の判定が複数箇所に
// 重複して定義ずれを起こさないよう、必ずここから import すること。
// =============================================================================

export function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nosp(s) {
  return s.replace(/[\s　]+/g, "");
}

// 科目名の照合用の正規化。空白を除くほか、半角括弧を全角に寄せる。
// 「国際関係法（公法系）」のように括弧を含む科目名は、法務省ページの
// リンク文字列や PDF 本文で半角括弧になっている場合があるため。
export function normSubject(s) {
  return nosp(s).replace(/\(/g, "（").replace(/\)/g, "）");
}

// マーカー照合用の正規化。空白を除き、半角数字を全角に寄せる。
// 原典PDFには「〔第 1 問〕」（半角数字・空白入り）と「〔第１問〕」が混在する
// （令和8年の知的財産法・労働法など）。
export function normMarker(s) {
  return nosp(s).replace(/[0-9]/g, (d) => "０１２３４５６７８９"[Number(d)]);
}

// 問マーカー（〔第１問〕など）を表記揺れごと照合する
export function hasMarker(text, marker) {
  return normMarker(text).includes(normMarker(marker));
}

// 科目名を、括弧が全角・半角どちらでもあたる正規表現ソースに変換する
// （normSubject と違い、正規化できない相手＝HTML文字列の検索に使う）。
export function subjectPattern(s) {
  return [...s]
    .map((ch) => {
      if (ch === "（" || ch === "(") return "[（(]";
      if (ch === "）" || ch === ")") return "[）)]";
      return reEscape(ch);
    })
    .join("");
}

// 設問見出し（〔設問〕〔設問１〕など。数字は全角・半角・省略を許容）
export const SETSUMON_RE = /^〔設問[0-9０-９]*〕/;

// 法律案・資料・事例などの構造マーカー行
// （「第１ ○○」「１ ○○」「１．○○」）
// ピリオドの後ろが数字のときは小数（配点の「3.5：1.5」など）なので除く。
export const STRUCTURE_MARKER_RE =
  /^(?:第[0-9０-９一二三四五六七八九十]+|[0-9０-９]+)(?:[　 ]|[．.](?![0-9０-９]))/;

// 項目の細別（公用文作成の考え方 Ⅰ-6 ウ の階層: 第１ → １ → （１） → ア →
// （ア））。原典PDFではこれらの見出しが本文と同じ字下げで置かれるため、段落の
// 区切りを字下げで判定すると前の段落に連結されてしまう。文末（。）の直後に
// これらが現れたら改行して独立させる。丸数字（①②）は上の階層表に無く、
// 「①については」のように文中参照でも使われるため対象にしない。
const ITEM_HEAD =
  "(?:第[0-9０-９一二三四五六七八九十]{1,3}[　 ]|[0-9０-９]{1,2}[　 ]|" +
  "[（(][0-9０-９]{1,2}[）)]|[⑴-⒇]|[ア-ン][　 ]|[（(][ア-ン][）)]|" +
  "〔[^〕]{1,12}〕|【[^】]{1,20}】)"; // 〔設問〕【資料】等の構造マーカーも見出し扱い
const ITEM_HEAD_AFTER_PERIOD = new RegExp(`。(?=${ITEM_HEAD})`, "g");

// 句読点・閉じ括弧の直前に入り込んだ空白（PDFの字送り由来）と、
// 2つ以上続く半角空白。原典の「〔設 問〕」のような1つの空白は残す。
const SPACE_BEFORE_PUNCT = /[ 　]+(?=[。、，．）)」』〕】])/g;
const MULTI_SPACE = /[ ]{2,}/g;

// 行の途中に紛れ込んだページ番号（「見なが- 2 -ら」）。前後が仮名・漢字の
// ときだけ取り除く（「法人税基本通達２−２−１２」等を壊さない）。
const PAGENUM_INLINE =
  /(?<=[ぁ-んァ-ヶ一-龥])[-‐‑–—―−]\s*[0-9０-９]{1,3}\s*[-‐‑–—―−](?=[ぁ-んァ-ヶ一-龥])/g;

// 段落テキストの仕上げ。段落内に埋もれた項目見出しを改行で独立させ、
// 空白とページ番号の残骸を落とす。戻り値は段落の配列（分割されうる）。
export function normalizeParagraph(text) {
  return text
    .replace(PAGENUM_INLINE, "")
    .replace(SPACE_BEFORE_PUNCT, "")
    .replace(MULTI_SPACE, " ")
    .replace(ITEM_HEAD_AFTER_PERIOD, "。\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 見出しらしい書き出し（ITEM_HEAD に「１．」形式を加えたもの）
const HEAD_LIKE_RE = new RegExp(`^(?:${ITEM_HEAD}|【)`);

// 段落が見出し行に見えるか（短く、句点を含まず、階層マーカーで始まる）。
// 「４ 法科大学院教育に求めるもの」のように文末記号が無くても、
// 次の段落の続きではない。
function isHeadingLine(s) {
  return (
    s.length <= 40 &&
    !/[。．]/.test(s) &&
    (HEAD_LIKE_RE.test(s) || STRUCTURE_MARKER_RE.test(s))
  );
}

// 改ページ等で文の途中に段落の区切りが入ってしまったものを繋ぎ直す。
// 前の段落が文末で終わっておらず、次の段落が仮名で始まる（＝見出しでも
// 会話の話者でもない文の続き）ときだけ結合する。
export function mergeBrokenParagraphs(paras) {
  const out = [];
  for (const p of paras) {
    const prev = out[out.length - 1];
    if (
      prev &&
      !SENTENCE_END_RE.test(prev) &&
      !isHeadingLine(prev) &&
      /^[ぁ-んー]/.test(p)
    ) {
      out[out.length - 1] = prev + p;
      continue;
    }
    out.push(p);
  }
  return out;
}

// 段落配列に normalizeParagraph を適用して平坦化する
export function normalizeParagraphs(paras) {
  return mergeBrokenParagraphs(paras.flatMap((p) => normalizeParagraph(p)));
}

// 会話文の開始（「甲：」「Ｘ：」のような短い話者名＋全角コロン）。
// 「注：」「例：」のような注記ラベルは話者として扱わない
export const DIALOGUE_RE =
  /^(?!(?:注|例|備考|凡例|出典|補足)[：:])[^\s。、．：]{1,4}：/;

// 文末記号で終わっているか（「。」「．」「！」「？」、後続に閉じカッコや空白を許容）
export const SENTENCE_END_RE = /[。．！？!?][」』）)\s]*$/;

// 採点実感のセクションタイトル（平成23年以前は「新司法試験」表記）
export function isSaitenTitle(t) {
  return (
    /^[令平].{1,8}年新?司法試験/.test(t) &&
    t.includes("採点実感") &&
    t.length < 80
  );
}
