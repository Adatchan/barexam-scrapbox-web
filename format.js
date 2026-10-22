// =============================================================================
// テキスト出力（ノーマル / Scrapbox 記法）
//
// 解析済みの段落配列（paras）を最終的な出力テキストに整形する。
// decorate=true のときだけ Scrapbox の装飾（見出し・字下げ・引用・太字・
// 判例リンク・関連ページへのリンク・#タグ）を付ける。太字は [* ] で表す。
// opts.deco で一部の装飾を切り替えられる（既定値は DECO_DEFAULTS）。
// =============================================================================
import {
  SETSUMON_RE,
  STRUCTURE_MARKER_RE,
  DIALOGUE_RE,
  isSaitenTitle,
  itemType,
  itemPrefix,
  isItemHeading,
  splitGluedHeadings,
  isBracketHeading,
  isShiryoHeading,
} from "./rules.js";

// 利用者が切り替えられる装飾
//   caseLinks:    判例（最判昭和○年○月○日 等）をページリンクにする
//   speakerBold:  会話文の話者名（甲：）を太字にする
//   keySentences: 「〜が求められる」「〜が必要である」で終わる文を太字にする
export const DECO_DEFAULTS = {
  caseLinks: true,
  speakerBold: true,
  keySentences: false,
};

// 公共データ利用規約（PDL1.0）に基づく出典・加工の表示
export function sourceLine(pdfUrl) {
  return `出典：法務省ウェブサイト（${pdfUrl}）を加工して作成`;
}

const wrap = (mark, s) => `[${mark} ${s}]`;

// 原典の半角 [ ] は Scrapbox ではリンク記法になり、全角と対になっていない
// こともある（「[設問３］」）。装飾の括弧と混ざらないよう全角にそろえる。
const escapeBrackets = (paras) =>
  paras.map((p) => p.replace(/\[/g, "［").replace(/\]/g, "］"));

// 各ページの名前（1行目）。Scrapbox 記法では、相互リンクできるよう
// 試験問題にも種類名を付けて「年度 試験　科目　種類」にそろえる。
function pageTitle(yearLabel, examTitle, subjectLabel, docType) {
  return `${yearLabel}${examTitle}　${subjectLabel}　${docType}`;
}

// タイトル・出典・タグ・関連ページの冒頭部分
function headerLines(
  { yearLabel, subjectLabel, docType, pdfUrl, decorate, tagDocType },
  opts,
) {
  const { examTitle = "司法試験", examTag = "司法試験", docTypes = [] } = opts;
  const out = [
    decorate || docType !== "試験問題"
      ? pageTitle(yearLabel, examTitle, subjectLabel, docType)
      : `${yearLabel}${examTitle}　${subjectLabel}`,
  ];
  if (pdfUrl) out.push(sourceLine(pdfUrl));
  if (decorate) {
    const m = /（(.+)）/.exec(subjectLabel);
    const tag = m ? m[1] : subjectLabel;
    out.push(
      `#${examTag} #${tag} #論文式 #${yearLabel}` +
        (tagDocType ? ` #${docType}` : ""),
    );
    const others = docTypes.filter((t) => t !== docType);
    if (others.length)
      out.push(
        "関連：" +
          others
            .map((t) => `[${pageTitle(yearLabel, examTitle, subjectLabel, t)}]`)
            .join(" "),
      );
  }
  out.push("");
  return out;
}

// 段落の書き出しに使われている階層マーカーの種類（itemType）を浅い順に並べ、
// 字下げの段数（0始まり）に対応づける。文書ごとに使う階層が異なる
// （「１」から始まる文書、「⑴」から始まる文書）ため、実際に現れた種類だけで詰める。
function rankMap(paras, types) {
  const seen = new Set(paras.map(itemType).filter((t) => types.includes(t)));
  const map = new Map();
  [...seen].sort((a, b) => a - b).forEach((t, i) => map.set(t, i));
  return map;
}

// ─── 判例リンク ────────────────────────────────────────────────────────
// 「最判昭和４２年１０月３１日」「東京高判平成…」のような略記と、
// 「最高裁判所平成２年…第一小法廷判決」のような正式な表記を、
// 略記・半角数字にそろえたページリンクにする（年度・科目をまたいで同じ判例が
// 同じページに集まるように）。「同判決」などの指示語は対象外。
const ERA_DATE =
  "((?:明治|大正|昭和|平成|令和)[0-9０-９元]{1,2}年[0-9０-９]{1,2}月[0-9０-９]{1,2}日)";
// 1回の置換で扱う（正式な表記を略記に直した結果を、略記のパターンで再び
// リンクにしてしまわないように）。
const CASE_RE = new RegExp(
  `最高裁(?:判所)?${ERA_DATE}(?:(大法廷)|第[一二三]小法廷)?(判決|決定)|` +
    `(?<![一-龥])((?:最大?|大連?|[一-龥]{1,3}(?:高|地|家)裁?)[判決])${ERA_DATE}`,
  "g",
);
const halfDigits = (s) =>
  s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

function linkCases(s) {
  return s.replace(CASE_RE, (_, longDate, grand, kind, court, shortDate) =>
    longDate
      ? `[最${grand ? "大" : ""}${kind === "決定" ? "決" : "判"}${halfDigits(longDate)}]`
      : `[${court}${halfDigits(shortDate)}]`,
  );
}

// ─── 本文中の太字 ──────────────────────────────────────────────────────
// 採点実感の評価区分（「優秀」「良好」「一応の水準」「不良」）。
// 「不良債権」等と取り違えないよう、「」で囲まれているか、答案・区分を
// 指す語が続くときだけ太字にする。
function boldGrades(s) {
  return s
    .replace(/「(優秀|良好|一応の水準|不良)」/g, "「[* $1]」")
    .replace(
      /(優秀|良好|一応の水準|不良)(?=(?:な|の)?答案|に属|に該当)/g,
      "[* $1]",
    );
}

// 出題の趣旨・採点実感で、受験者に何が求められているかを述べる文
const KEY_SENTENCE_RE =
  /(?:求められる|求められている|必要である|必要がある|期待される|望まれる)(?:もの(?:である|と考えられる))?[。．][」』）)]*$/;
const SENTENCE_RE = /[^。．]*[。．][」』）)]*|[^。．]+$/g;

function decorateBody(s, docType, deco) {
  let out = s;
  if (deco.keySentences || docType === "採点実感") {
    out = (out.match(SENTENCE_RE) || [out])
      .map((sent) => {
        if (deco.keySentences && KEY_SENTENCE_RE.test(sent)) {
          const lead = sent.match(/^\s*/)[0];
          return `${lead}[* ${sent.slice(lead.length)}]`;
        }
        return docType === "採点実感" ? boldGrades(sent) : sent;
      })
      .join("");
  }
  return deco.caseLinks ? linkCases(out) : out;
}

// 会話文の話者名（「甲：」）を太字にする
function boldSpeaker(p) {
  const m = DIALOGUE_RE.exec(p);
  if (!m) return p;
  return `[* ${m[0].slice(0, -1)}]：${p.slice(m[0].length)}`;
}

// ─── 試験問題 ──────────────────────────────────────────────────────────
export function toScrapbox(
  paras,
  yearLabel,
  subjectLabel,
  pdfUrl,
  decorate,
  opts = {},
) {
  const deco = { ...DECO_DEFAULTS, ...opts.deco };
  const out = headerLines(
    { yearLabel, subjectLabel, docType: "試験問題", pdfUrl, decorate },
    opts,
  );
  if (decorate) paras = escapeBrackets(paras);
  // ⑴・ア・（ア）の項目は階層に応じて字下げする（第１・１ は行頭のまま）
  const ranks = rankMap(paras, [2, 3, 4]);
  // 構造マーカー行（「第１ ○○」「１ ○○」「１．○○」）と会話文
  // （「甲：」「Ｘ：」）は空行なしの連続行として出力する
  let inDialogue = false;
  let inMarkerBlock = false;
  // 【資料】の後ろ（次の設問・問・【…】見出しまで）は引用として出力する
  let inShiryo = false;
  for (const p of paras) {
    const dialogue = DIALOGUE_RE.test(p);
    const marker = !dialogue && STRUCTURE_MARKER_RE.test(p);
    const setsumon = SETSUMON_RE.test(p);
    const bracket = isBracketHeading(p);
    if (setsumon || bracket || /^〔第.{1,3}問〕/.test(p)) inShiryo = false;

    let line = p;
    if (decorate) {
      if (dialogue && deco.speakerBold) line = boldSpeaker(p);
      if (inShiryo) line = `> ${line}`;
      else if (ranks.has(itemType(p)))
        line = " ".repeat(ranks.get(itemType(p)) + 1) + line;
    }

    // 連続行ブロック（会話・番号付き項目）の終わりには空行を1つ入れる
    if ((inDialogue && !dialogue) || (inMarkerBlock && !marker && !dialogue))
      out.push("");
    if (setsumon) {
      // 設問見出しは前に空行を1つ足し（計2行空け）、直後の本文は次行に続ける
      out.push("");
      out.push(decorate ? wrap("**", p) : p);
    } else if (bracket) {
      const shiryo = isShiryoHeading(p);
      if (decorate) {
        // 見出しの後ろに題名・条項が続く【資料】は、見出しと本文を分ける
        const head = p.slice(0, p.indexOf("】") + 1);
        const rest = p.slice(head.length).trim();
        out.push(wrap("*", shiryo && rest ? head : p));
        if (shiryo && rest) out.push(`> ${rest}`);
      } else out.push(p);
      // 【資料】は直後に題名・条項が続くため空行を入れない
      if (!p.includes("資料")) out.push("");
      inShiryo = shiryo;
    } else if (dialogue) {
      // 直前の段落・発言と空行なしで詰める
      if (out[out.length - 1] === "") out.pop();
      out.push(line);
    } else if (marker) {
      out.push(line);
    } else {
      out.push(line);
      out.push("");
    }
    inDialogue = dialogue;
    inMarkerBlock = marker;
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

// ─── 出題の趣旨・採点実感 ──────────────────────────────────────────────
export function toScrapboxNarrative(
  paras,
  yearLabel,
  subjectLabel,
  docType,
  pdfUrl,
  decorate,
  opts = {},
) {
  const deco = { ...DECO_DEFAULTS, ...opts.deco };
  const out = headerLines(
    { yearLabel, subjectLabel, docType, pdfUrl, decorate, tagDocType: true },
    opts,
  );
  // 採点実感で1段落に連結された見出しを切り離してから整形する
  const items = (decorate ? escapeBrackets(paras) : paras).flatMap((p) =>
    splitGluedHeadings(p),
  );
  const ranks = rankMap(items, [0, 1, 2, 3, 4]);
  // 直前の項目（階層マーカーで始まる段落）。マーカーの無い段落は、直前の
  // 項目が見出しならその1段下、本文ならそれと同じ段に字下げする。
  let last = null;
  for (const p of items) {
    const ps = p.trim();
    if (isSaitenTitle(ps) || /^〔第[１２３]問〕$/.test(ps)) {
      out.push(decorate ? wrap("***", ps) : p);
      last = null;
    } else if (/^【.+】$/.test(ps)) {
      out.push(decorate ? wrap("*", ps) : p);
      last = null;
    } else if (!decorate) {
      out.push(p);
    } else {
      const t = itemType(ps);
      let indent;
      if (ranks.has(t)) {
        last = { rank: ranks.get(t), heading: isItemHeading(ps) };
        indent = last.rank;
      } else if (!last) indent = 0;
      else if (last.heading) indent = last.rank === 0 ? 0 : last.rank + 1;
      else indent = last.rank;
      const sp = " ".repeat(indent);
      if (ranks.has(t) && last.heading)
        out.push(sp + wrap(last.rank === 0 ? "**" : "*", ps));
      else {
        // 文を太字にするときにマーカーまで囲まないよう、先頭のマーカーは外す
        const head = itemPrefix(ps);
        out.push(sp + head + decorateBody(ps.slice(head.length), docType, deco));
      }
    }
    out.push("");
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}
