// =============================================================================
// テキスト出力（ノーマル / Scrapbox 記法）
//
// 解析済みの段落配列（paras）を最終的な出力テキストに整形する。
// decorate=true のときだけ Scrapbox の装飾（[* ] [** ] #タグ）を付ける。
// =============================================================================
import {
  SETSUMON_RE,
  STRUCTURE_MARKER_RE,
  DIALOGUE_RE,
  isSaitenTitle,
} from "./rules.js";

// 公共データ利用規約（PDL1.0）に基づく出典・加工の表示
export function sourceLine(pdfUrl) {
  return `出典：法務省ウェブサイト（${pdfUrl}）を加工して作成`;
}

export function toScrapbox(paras, yearLabel, subjectLabel, pdfUrl, decorate) {
  const out = [`${yearLabel}司法試験　${subjectLabel}`];
  if (pdfUrl) out.push(sourceLine(pdfUrl));
  if (decorate) {
    const m = /（(.+)）/.exec(subjectLabel);
    const tag = m ? m[1] : subjectLabel;
    out.push(`#司法試験 #${tag} #論文式 #${yearLabel}`);
  }
  out.push("");
  // 構造マーカー行（「第１ ○○」「１ ○○」「１．○○」）と会話文
  // （「甲：」「Ｘ：」）は空行なしの連続行として出力する
  let inDialogue = false;
  let inMarkerBlock = false;
  for (const p of paras) {
    const dialogue = DIALOGUE_RE.test(p);
    const marker = !dialogue && STRUCTURE_MARKER_RE.test(p);
    // 連続行ブロック（会話・番号付き項目）の終わりには空行を1つ入れる
    if ((inDialogue && !dialogue) || (inMarkerBlock && !marker && !dialogue))
      out.push("");
    if (SETSUMON_RE.test(p)) {
      // 設問見出しは前に空行を1つ足し（計2行空け）、直後の本文は次行に続ける
      out.push("");
      out.push(decorate ? `[** ${p}]` : p);
    } else if (/^【.+】/.test(p)) {
      out.push(decorate ? `[* ${p}]` : p);
      // 【資料】は直後に題名・条項が続くため空行を入れない
      if (!p.includes("資料")) out.push("");
    } else if (dialogue) {
      // 直前の段落・発言と空行なしで詰める
      if (out[out.length - 1] === "") out.pop();
      out.push(p);
    } else if (marker) {
      out.push(p);
    } else {
      out.push(p);
      out.push("");
    }
    inDialogue = dialogue;
    inMarkerBlock = marker;
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

export function toScrapboxNarrative(
  paras,
  yearLabel,
  subjectLabel,
  docType,
  pdfUrl,
  decorate,
) {
  const out = [`${yearLabel}司法試験　${subjectLabel}　${docType}`];
  if (pdfUrl) out.push(sourceLine(pdfUrl));
  if (decorate) {
    const m = /（(.+)）/.exec(subjectLabel);
    const tag = m ? m[1] : subjectLabel;
    out.push(`#司法試験 #${tag} #論文式 #${yearLabel} #${docType}`);
  }
  out.push("");
  for (const p of paras) {
    const ps = p.trim();
    if (isSaitenTitle(p)) out.push(decorate ? `[** ${p}]` : p);
    else if (/^〔第[１２３]問〕$/.test(ps))
      out.push(decorate ? `[** ${ps}]` : ps);
    else if (/^【.+】$/.test(ps)) out.push(decorate ? `[* ${ps}]` : ps);
    else if (
      p.length < 30 &&
      /^[１２３４５６７８９\d]+[　\s]/.test(p) &&
      !p.includes("\n")
    )
      out.push(decorate ? `[* ${p}]` : p);
    else out.push(p);
    out.push("");
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}
