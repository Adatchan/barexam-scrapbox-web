// =============================================================================
// 更新情報
//
// このファイルは scripts/update-years.mjs により自動更新されます。
// NEWS / TANTOU_NEWS: 各画面の「更新情報」欄に表示されるお知らせ（新しい順）
//   - NEWS        … 論文式（index.html）
//   - TANTOU_NEWS … 短答式（tantou.html）
// CRAWL_STATE / TANTOU_CRAWL_STATE: 年度ごとの掲載を確認済みかの記録
//   （未確認の項目だけを週次クロールで再チェックする）
//   - CRAWL_STATE        … 論文式の 出題の趣旨(shushi)・採点実感(saiten)
//   - TANTOU_CRAWL_STATE … 短答式の 問題(mondai)・正答及び配点(seikai)
// =============================================================================

export const NEWS = [
  { date: "2026.07.21", text: "令和8年の試験問題が掲載されました。" },
  { date: "2026.07.20", text: "自動クロール機能が実装されました。新年度の試験問題・出題の趣旨・採点実感は、法務省ウェブへの掲載後1週間以内に自動で追加されます。" },
];

export const CRAWL_STATE = {
  h22: { shushi: true, saiten: true },
  h23: { shushi: true, saiten: true },
  h24: { shushi: true, saiten: true },
  h25: { shushi: true, saiten: true },
  h26: { shushi: true, saiten: true },
  h27: { shushi: true, saiten: true },
  h28: { shushi: true, saiten: true },
  h29: { shushi: true, saiten: true },
  h30: { shushi: true, saiten: true },
  r1: { shushi: true, saiten: true },
  r2: { shushi: true, saiten: true },
  r3: { shushi: true, saiten: true },
  r4: { shushi: true, saiten: true },
  r5: { shushi: true, saiten: true },
  r6: { shushi: true, saiten: true },
  r7: { shushi: true, saiten: true },
  r8: { shushi: false, saiten: false },
};

export const TANTOU_NEWS = [
  { date: "2026.07.21", text: "令和8年の短答式問題が掲載されました。" },
  { date: "2026.07.20", text: "自動クロール機能が実装されました。新年度の短答式問題・正答及び配点は、法務省ウェブへの掲載後1週間以内に自動で追加されます。" },
];

export const TANTOU_CRAWL_STATE = {
  h27: { mondai: true, seikai: true },
  h28: { mondai: true, seikai: true },
  h29: { mondai: true, seikai: true },
  h30: { mondai: true, seikai: true },
  r1: { mondai: true, seikai: true },
  r2: { mondai: true, seikai: true },
  r3: { mondai: true, seikai: true },
  r4: { mondai: true, seikai: true },
  r5: { mondai: true, seikai: true },
  r6: { mondai: true, seikai: true },
  r7: { mondai: true, seikai: true },
  r8: { mondai: true, seikai: false },
};
