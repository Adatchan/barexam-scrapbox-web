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

const SELECT_KEYWORDS = ["経済法", "労働法", "倒産法"];

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    return `${label}:OK`;
  } catch (e) {
    failures++;
    return `${label}:NG(${e.message})`;
  }
}

for (const [year, examUrl] of Object.entries(YEAR_URL_MAP)) {
  const row = [year];

  // 試験問題（基本科目の系列と選択科目の問題集）
  row.push(await check("問題", () => fetchExamPdfUrl(examUrl, "公法系科目")));
  row.push(
    await check("問題選択", () => fetchExamPdfUrl(examUrl, "選択科目")),
  );

  // 出題の趣旨・採点実感（結果ページが掲載済みの年度のみ）
  const resultsUrl = RESULTS_URL_MAP[year];
  if (resultsUrl) {
    row.push(await check("趣旨", () => fetchShushiPdfUrl(resultsUrl, null)));
    row.push(
      await check("採点", () =>
        fetchSaitenPdfUrl(resultsUrl, "公法系科目", null),
      ),
    );
    for (const kw of SELECT_KEYWORDS) {
      row.push(
        await check(`趣旨${kw}`, () => fetchShushiPdfUrl(resultsUrl, kw)),
      );
      row.push(
        await check(`採点${kw}`, () =>
          fetchSaitenPdfUrl(resultsUrl, "選択科目", kw),
        ),
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
        ),
      );
    }
  }

  console.log(row.join("  "));
}

if (failures > 0) {
  console.error(`\nNG ${failures} 件。法務省ページの構造変更の可能性があります。`);
  process.exit(1);
}
console.log("\n全チェック OK");
