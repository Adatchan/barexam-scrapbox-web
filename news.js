// =============================================================================
// 更新情報
//
// このファイルは scripts/update-years.mjs により自動更新されます。
// NEWS: 画面の「更新情報」欄に表示されるお知らせ（新しい順）
// CRAWL_STATE: 年度ごとに出題の趣旨・採点実感の掲載を確認済みかの記録
//              （未確認の項目だけを週次クロールで再チェックする）
// =============================================================================

export const NEWS = [
  { date: "2026.06.10", text: "自動クロール機能が実装されました。新年度の試験問題・出題の趣旨・採点実感は、法務省ウェブへの掲載後1週間以内に自動で追加されます。" },
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
