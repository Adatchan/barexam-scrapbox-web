// =============================================================================
// PDF リンク探索の健全性チェック
//
// アプリ本体と同じ moj.js（Cloudflare Worker 中継）を使い、全年度×全種類で
// 法務省ページから PDF リンクを特定できるかを検査する。法務省サイトの
// 構造変更や Worker の障害を検知するため、週次ワークフローから実行される
// （失敗すると GitHub がワークフローの失敗を通知する）。
//
// 使い方: node scripts/check-links.mjs
// =============================================================================
import { YEAR_URL_MAP, RESULTS_URL_MAP } from "../years.js";
import { YOBI_YEAR_URL_MAP, YOBI_RESULTS_URL_MAP } from "../yobi-years.js";
import {
  fetchExamPdfUrl,
  fetchShushiPdfUrl,
  fetchSaitenPdfUrl,
} from "../moj.js";
import {
  isThreeSubjectYear,
  findTantouQuestionPdfUrl,
  findTantouAnswerPdfUrl,
} from "../tantou-moj.js";
import { findYobiRonbunPdfUrl, findYobiShushiPdfUrl } from "../yobi-moj.js";

const SELECT_KEYWORDS = ["経済法", "労働法", "倒産法"];

// 年度キー（h22, r1 など）を西暦に変換して最新年度を求める。
// 最新年度は趣旨・採点実感などが未公表なだけの可能性が高いため、
// リンクが見つからなくても失敗ではなく警告として扱う。
const toAd = (y) =>
  (y[0] === "h" ? 1988 : 2018) + Number(y.slice(1));
const latestOf = (map) =>
  Object.keys(map).reduce((a, b) => (toAd(a) >= toAd(b) ? a : b));

let failures = 0;
let warnings = 0;
async function check(label, fn, soft = false) {
  try {
    await fn();
    return `${label}:OK`;
  } catch (e) {
    if (soft) {
      warnings++;
      return `${label}:未掲載?(${e.message})`;
    }
    failures++;
    return `${label}:NG(${e.message})`;
  }
}

const LATEST = latestOf(YEAR_URL_MAP);
for (const [year, examUrl] of Object.entries(YEAR_URL_MAP)) {
  const row = [year];
  const soft = year === LATEST;

  // 試験問題（基本科目の系列と選択科目の問題集）
  row.push(await check("問題", () => fetchExamPdfUrl(examUrl, "公法系科目")));
  row.push(
    await check("問題選択", () => fetchExamPdfUrl(examUrl, "選択科目")),
  );

  // 出題の趣旨・採点実感（結果ページが掲載済みの年度のみ）
  const resultsUrl = RESULTS_URL_MAP[year];
  if (resultsUrl) {
    row.push(await check("趣旨", () => fetchShushiPdfUrl(resultsUrl, null), soft));
    row.push(
      await check("採点", () =>
        fetchSaitenPdfUrl(resultsUrl, "公法系科目", null),
      soft),
    );
    for (const kw of SELECT_KEYWORDS) {
      row.push(
        await check(`趣旨${kw}`, () => fetchShushiPdfUrl(resultsUrl, kw), soft),
      );
      row.push(
        await check(`採点${kw}`, () =>
          fetchSaitenPdfUrl(resultsUrl, "選択科目", kw),
        soft),
      );
    }
  } else {
    row.push("結果ページ未掲載のため趣旨・採点はスキップ");
  }

  // 短答式（3科目制 = 平成27年以降）の問題・正答リンク（代表として憲法）
  if (isThreeSubjectYear(year)) {
    row.push(
      await check("短答問題", () =>
        findTantouQuestionPdfUrl(examUrl, "憲法"),
      ),
    );
    if (resultsUrl) {
      row.push(
        await check("短答正答", () =>
          findTantouAnswerPdfUrl(resultsUrl, "憲法"),
        soft),
      );
    }
  }

  console.log(row.join("  "));
}

// 予備試験（jinji07 系統・科目グループ別）。代表として「憲法・行政法」で
// 短答問題・短答正答・論文問題・論文出題の趣旨のリンク探索を検査する。
const YOBI_LATEST = latestOf(YOBI_YEAR_URL_MAP);
for (const [year, examUrl] of Object.entries(YOBI_YEAR_URL_MAP)) {
  const row = [`予備${year}`];
  const soft = year === YOBI_LATEST;
  const subj = "憲法・行政法";
  row.push(
    await check("短答問題", () => findTantouQuestionPdfUrl(examUrl, subj)),
  );
  row.push(await check("論文問題", () => findYobiRonbunPdfUrl(examUrl, subj), soft));
  const resultsUrl = YOBI_RESULTS_URL_MAP[year];
  if (resultsUrl) {
    row.push(
      await check("短答正答", () => findTantouAnswerPdfUrl(resultsUrl, subj), soft),
    );
    row.push(await check("論文趣旨", () => findYobiShushiPdfUrl(resultsUrl), soft));
  } else {
    row.push("結果ページ未掲載のためスキップ");
  }
  console.log(row.join("  "));
}

if (warnings > 0) {
  console.log(
    `\n未掲載? ${warnings} 件（最新年度）。公表され次第 OK になる想定のため失敗にはしない。`,
  );
}
if (failures > 0) {
  console.error(`\nNG ${failures} 件。法務省ページの構造変更の可能性があります。`);
  process.exit(1);
}
console.log("\n全チェック OK");
