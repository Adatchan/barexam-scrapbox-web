// 一時診断（平成22年の民事系PDFの構成調査用・調査後に削除する）
const { fetchHtml } = await import("../moj.js");
const { YEAR_URL_MAP, RESULTS_URL_MAP } = await import("../years.js");

for (const [label, url] of [
  ["h22 試験問題ページ", YEAR_URL_MAP.h22],
  ["h22 結果ページ", RESULTS_URL_MAP.h22],
]) {
  const html = await fetchHtml(url);
  console.log(`\n### ${label}: ${url}`);
  for (const [, href, text] of html.matchAll(/href="([^"#]+\.pdf)"[^>]*>([^<]*)</g)) {
    console.log(`  ${text.replace(/\s+/g, " ").trim()} -> ${href}`);
  }
  for (const [, href, text] of html.matchAll(
    /href="((?:https?:\/\/www\.moj\.go\.jp)?\/jinji[^"]+\.html)"[^>]*>([^<]*)</g,
  )) {
    const t = text.replace(/\s+/g, " ").trim();
    if (!/趣旨|採点|問題/.test(t)) continue;
    const sub = new URL(href, url).href;
    console.log(`\n  --- サブページ「${t}」: ${sub}`);
    const subHtml = await fetchHtml(sub);
    for (const [, h, x] of subHtml.matchAll(/href="([^"#]+\.pdf)"[^>]*>([^<]*)</g)) {
      console.log(`    ${x.replace(/\s+/g, " ").trim()} -> ${h}`);
    }
  }
}
