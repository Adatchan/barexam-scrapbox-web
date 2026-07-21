// =============================================================================
// 司法試験予備試験  年度 → 法務省ページ URL 対応表
//
// このファイルは scripts/update-years.mjs により自動生成・更新されます。
// 手で編集しても次回の自動更新で新年度の追記が行われます（既存行は保持）。
//
// 予備試験は司法試験（years.js / jinji08_*）とは別系統（jinji07_*）で、
// 試験問題・正解及び配点は科目グループ別（憲法・行政法 など）に公表される。
// 平成31年実施分は結果が「令和元年」表記のため r1 に正規化している。
// =============================================================================

// 試験問題ページ（短答式・論文式の問題PDFの掲載元）
export const YOBI_YEAR_URL_MAP = {
  h23: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00039.html",
  h24: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00066.html",
  h25: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00094.html",
  h26: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00118.html",
  h27: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00145.html",
  h28: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00173.html",
  h29: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00205.html",
  h30: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00230.html",
  r1: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00245.html",
  r2: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00016.html",
  r3: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00068.html",
  r4: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00102.html",
  r5: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00151.html",
  r6: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00228.html",
  r7: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00287.html",
  r8: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00317.html",
};

// 結果ページ（短答式の正解及び配点・論文式の出題の趣旨の掲載元）
export const YOBI_RESULTS_URL_MAP = {
  h23: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00032.html",
  h24: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_000101.html",
  h25: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00093.html",
  h26: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00117.html",
  h27: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00142.html",
  h28: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00170.html",
  h29: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00204.html",
  h30: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00229.html",
  r1: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00243.html",
  r2: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00004.html",
  r3: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00065.html",
  r4: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00098.html",
  r5: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00144.html",
  r6: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00213.html",
  r7: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00285.html",
  r8: "https://www.moj.go.jp/jinji/shihoushiken/jinji07_00315.html",
};
