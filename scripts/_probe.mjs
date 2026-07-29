// 一時: rules.js の段落正規化（normalizeParagraph）の回帰確認
//
// 「公用文作成の考え方」Ⅰ-6 の階層見出しと、原典PDFに現れる構造マーカー
// （〔設問〕【資料】）が、句点の直後で正しく改行されるかを確かめる。
// 使い方: node scripts/_probe.mjs
import { normalizeParagraph } from "../rules.js";

let ng = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "OK " : "NG "} ${label}`);
  if (!cond) ng++;
};
const split = (s) => normalizeParagraph(s).join("|");

ok(
  split("大きく下回ることとなった。〔設 問〕Ｘ社の行為について") ===
    "大きく下回ることとなった。|〔設 問〕Ｘ社の行為について",
  "〔設 問〕で分割",
);
ok(
  split("と反論した。〔設問１⑴〕") === "と反論した。|〔設問１⑴〕",
  "〔設問１⑴〕で分割",
);
ok(
  split("求めるものである。【Ｓ市都市計画課の会議録】において示唆した") ===
    "求めるものである。|【Ｓ市都市計画課の会議録】において示唆した",
  "【…】で分割",
);

// 句点を挟まない連続見出しは分割対象外（原典の字送り情報が無く判別できない）
ok(
  normalizeParagraph("第３ 採点実感等１ 第１問について").length === 1,
  "句点が無ければ分割しない",
);
// 丸数字は階層表に無く、「①については」のような文中参照でも使われる
ok(
  normalizeParagraph("可否である。①については").length === 1,
  "丸数字①は分割しない",
);
ok(normalizeParagraph("という。〔以下省略〕").length === 2, "短い〔…〕でも分割");
// 〔…〕が長い場合は見出しではなく引用・注記とみなす
ok(
  normalizeParagraph("である。〔" + "あ".repeat(20) + "〕").length === 1,
  "長すぎる〔…〕は見出し扱いしない",
);

console.log(ng === 0 ? "\n全テストOK" : `\nNG ${ng}件`);
process.exit(ng ? 1 : 0);
