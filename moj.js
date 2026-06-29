// =============================================================================
// 法務省ウェブからの取得
//
// moj.go.jp は CORS を許可していないため、ブラウザからは Cloudflare Worker
// （同梱の worker/worker.js）を中継して取得する。Node から実行した場合も
// 同じ Worker を経由するため、scripts/check-links.mjs が本番と同一の
// コードパスを検査できる。
// =============================================================================
import { reEscape } from "./rules.js";

export const WORKER_URL =
  "https://shihoshiken-proxy.adachiyuki0409.workers.dev";

const FETCH_TIMEOUT_MS = 30000;

// バイト数を読みやすい KB 表記にする（例: 2,013,817 バイト → "1,967 KB"）。
// ログ表示の共通ヘルパ（convert.js / app.js / tantou.js から利用）。
export function formatKB(bytes) {
  return `${Math.round(bytes / 1024).toLocaleString()} KB`;
}

function resolveUrl(href, baseUrl) {
  if (/^https?:/.test(href)) return href;
  return new URL(href, baseUrl).toString();
}

// 取得元 → 表示ラベル。3階層を区別する:
//   MEMORY        … このタブで取得済み（再取得せずメモリから・ネットワーク無し）
//   R2HIT         … Cloudflare R2 から配信（PDF永続キャッシュ・法務省へは行かない）
//   HIT/REVALIDATED … Cloudflare エッジから配信（法務省へは行かない）
//   それ以外(MISS/EXPIRED/UPDATING…) … Cloudflare が法務省 origin へ取りに行く
// X-MOJ-Cache が読めない（旧Worker・未公開）場合は null。
export function cacheSourceLabel(status) {
  if (!status) return null;
  if (/^MEMORY$/i.test(status)) return "💾 メモリ（取得済み）";
  if (/^R2HIT$/i.test(status)) return "📦 Cloudflare R2（保存済み）";
  return /^(HIT|REVALIDATED)$/i.test(status)
    ? "⚡ Cloudflareキャッシュ"
    : "🌐 法務省サイト";
}

async function fetchViaProxy(url, type = "text", onMeta) {
  const proxyUrl = `${WORKER_URL}/?url=${encodeURIComponent(url)}`;
  let res;
  try {
    res = await fetch(proxyUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // ブラウザHTTPキャッシュを迂回し、毎回エッジの HIT/MISS を観察できるように
      // する（取得元ログを正確にするため。ブラウザ側の再キャッシュは行わない）
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(
      e.name === "TimeoutError"
        ? `取得がタイムアウトしました（${FETCH_TIMEOUT_MS / 1000}秒）: ${url}`
        : `取得に失敗しました: ${e.message} (${url})`,
    );
  }
  if (!res.ok) {
    throw new Error(`取得失敗 HTTP ${res.status}: ${url}`);
  }
  if (onMeta) onMeta({ cache: res.headers.get("X-MOJ-Cache") });
  if (type === "arraybuffer") return await res.arrayBuffer();
  return await res.text();
}

// 同一ページの再取得を避けるキャッシュ（一括zip保存や検査スクリプトで、
// 同じ結果ページを種類ごとに引き直すのを防ぐ）。並列取得で同じページを同時に
// 引いても1回の取得に集約できるよう、解決済みテキストではなく取得中の Promise
// を保持する（失敗時はエントリを消して次回の再取得を許す）。
const htmlCache = new Map();

export async function fetchHtml(url) {
  if (htmlCache.has(url)) return htmlCache.get(url);
  const p = fetchViaProxy(url, "text").catch((e) => {
    htmlCache.delete(url);
    throw e;
  });
  htmlCache.set(url, p);
  return p;
}

// 取得済みPDFバイトのメモリキャッシュ（URLキー）。予備の出題の趣旨（全科目を
// まとめた1PDF）や科目グループの問題PDFは、同一年度で科目を変えても同じURLな
// ので、別科目への切替時に取得し直さず再利用する。getDocument / pdf-lib は渡
// されたバッファを detach するため、保持するのは master とし、呼び出し側へは
// 毎回コピーを返す。容量・件数に上限を設ける（モバイル考慮）。
const pdfCache = new Map(); // url -> Uint8Array（master）
const pdfInflight = new Map(); // url -> Promise<Uint8Array>（取得中の集約）
const PDF_CACHE_MAX_ENTRIES = 8;
const PDF_CACHE_MAX_BYTES = 40 * 1024 * 1024;

function pdfCacheBytes() {
  let t = 0;
  for (const v of pdfCache.values()) t += v.byteLength;
  return t;
}
function pdfCachePut(url, u8) {
  pdfCache.delete(url);
  pdfCache.set(url, u8); // 末尾＝最近使用（LRU）
  while (
    pdfCache.size > 1 &&
    (pdfCache.size > PDF_CACHE_MAX_ENTRIES ||
      pdfCacheBytes() > PDF_CACHE_MAX_BYTES)
  ) {
    pdfCache.delete(pdfCache.keys().next().value); // 先頭＝最古を破棄
  }
}

// onMeta({ cache }) で取得元（MEMORY / X-MOJ-Cache）を受け取れる（ログ表示用・
// 任意）。同一URLは取得済みならメモリから返し、ネットワークへ行かない。
export async function fetchPdf(url, onMeta) {
  const cached = pdfCache.get(url);
  if (cached) {
    pdfCachePut(url, cached); // LRU 更新
    if (onMeta) onMeta({ cache: "MEMORY" });
    return cached.slice().buffer; // 呼び出し側が detach するので毎回コピー
  }
  let inflight = pdfInflight.get(url);
  if (inflight) {
    // 取得中に相乗り（重複ダウンロードを避ける）。取得元はメモリ扱いにする。
    const u8 = await inflight;
    if (onMeta) onMeta({ cache: "MEMORY" });
    return u8.slice().buffer;
  }
  inflight = (async () => {
    const buf = await fetchViaProxy(url, "arraybuffer", onMeta);
    const u8 = new Uint8Array(buf);
    pdfCachePut(url, u8);
    return u8;
  })().finally(() => pdfInflight.delete(url));
  pdfInflight.set(url, inflight);
  const u8 = await inflight;
  return u8.slice().buffer;
}

// ─── PDF URL 取得（試験問題） ─────────────────────────────────────────────
export async function fetchExamPdfUrl(pageUrl, systemName) {
  const html = await fetchHtml(pageUrl);
  const idx = html.indexOf("論文式試験");
  const section = idx !== -1 ? html.slice(idx) : html;
  const escaped = reEscape(systemName);
  const PDF = `href="([^"#]+\\.pdf)"`;

  const patterns = [
    new RegExp(`${PDF}[^>]*>\\s*${escaped}\\s*<`),
    new RegExp(`${PDF}[^>]*>\\s*${escaped}`),
    new RegExp(`${PDF}[^>]*>(?:[^<]*<[^>]+>)*\\s*${escaped}`),
  ];
  for (const p of patterns) {
    const m = p.exec(section);
    if (m) return resolveUrl(m[1], pageUrl);
  }

  // Pattern 4: 最近接 PDF リンク
  let bestDist = Infinity;
  let bestHref = null;
  const nameRe = new RegExp(escaped, "g");
  const linkRe = new RegExp(PDF, "g");
  const names = [...section.matchAll(nameRe)];
  const links = [...section.matchAll(linkRe)];
  for (const nm of names) {
    for (const lm of links) {
      const dist = Math.abs(lm.index - nm.index);
      if (dist < bestDist) {
        bestDist = dist;
        bestHref = lm[1];
      }
    }
  }
  if (bestHref && bestDist < 500) return resolveUrl(bestHref, pageUrl);

  throw new Error(
    `「${systemName}」のPDFリンクが見つかりません。(ページ: ${pageUrl})`,
  );
}

// ─── PDF URL 取得（出題の趣旨） ───────────────────────────────────────────
export async function fetchShushiPdfUrl(resultsUrl, sectionKeyword) {
  const html = await fetchHtml(resultsUrl);

  if (sectionKeyword) {
    const kw = reEscape(sectionKeyword);
    const p = new RegExp(
      `href="([^"#]+\\.pdf)"[^>]*>[^<]*(?:出題の趣旨[^<]*${kw}|${kw}[^<]*出題の趣旨)`,
    );
    const m = p.exec(html);
    if (m) return resolveUrl(m[1], resultsUrl);
  }

  // サブページへのリンクは相対（/jinji/...）と絶対（https://www.moj.go.jp/jinji/...）
  // の両方の書き方が混在する（例: 令和元年は絶対URL）
  const subM =
    /href="((?:https?:\/\/www\.moj\.go\.jp)?\/jinji[^"]+\.html)"[^>]*>[^<]*出題の趣旨/.exec(
      html,
    );

  if (subM && sectionKeyword) {
    const subUrl = resolveUrl(subM[1], resultsUrl);
    const subHtml = await fetchHtml(subUrl);
    const kw = reEscape(sectionKeyword);
    let m2 = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>[^<]*${kw}`).exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
    m2 = /href="([^"#]+\.pdf)"[^>]*>[^<]*選択科目/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
  }

  const p1 = /href="([^"#]+\.pdf)"[^>]*>[^<]*出題の趣旨/.exec(html);
  if (p1) return resolveUrl(p1[1], resultsUrl);

  if (subM) {
    const subUrl = resolveUrl(subM[1], resultsUrl);
    const subHtml = await fetchHtml(subUrl);
    const m2 = /href="([^"#]+\.pdf)"/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
  }

  throw new Error(`出題の趣旨PDFが見つかりません。(ページ: ${resultsUrl})`);
}

// ─── PDF URL 取得（採点実感） ─────────────────────────────────────────────
export async function fetchSaitenPdfUrl(resultsUrl, systemName, sectionKeyword) {
  const html = await fetchHtml(resultsUrl);

  if (sectionKeyword) {
    const kw = reEscape(sectionKeyword);
    const p = new RegExp(
      `href="([^"#]+\\.pdf)"[^>]*>[^<]*(?:採点実感[^<]*${kw}|${kw}[^<]*採点実感)`,
    );
    const m = p.exec(html);
    if (m) return resolveUrl(m[1], resultsUrl);
  }

  const directM = /href="([^"#]+\.pdf)"[^>]*>[^<]*採点実感/.exec(html);
  // 相対・絶対どちらの URL 表記でもサブページを拾う（令和元年は絶対URL）
  const subM =
    /href="((?:https?:\/\/www\.moj\.go\.jp)?\/jinji[^"]+\.html)"[^>]*>[^<]*採点実感/.exec(
      html,
    );

  if (subM) {
    const subUrl = resolveUrl(subM[1], resultsUrl);
    const subHtml = await fetchHtml(subUrl);
    const target = sectionKeyword || systemName;
    const escaped = reEscape(target);

    let m2 = new RegExp(`href="([^"#]+\\.pdf)"[^>]*>[^<]*${escaped}`).exec(
      subHtml,
    );
    if (m2) return resolveUrl(m2[1], subUrl);

    if (sectionKeyword) {
      m2 = /href="([^"#]+\.pdf)"[^>]*>[^<]*選択科目/.exec(subHtml);
      if (m2) return resolveUrl(m2[1], subUrl);
    }

    m2 = /href="([^"#]+\.pdf)"[^>]*>[^<]*採点実感/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);

    m2 = /href="([^"#]+\.pdf)"/.exec(subHtml);
    if (m2) return resolveUrl(m2[1], subUrl);
  }

  if (directM) return resolveUrl(directM[1], resultsUrl);

  throw new Error(`採点実感PDFが見つかりません。(ページ: ${resultsUrl})`);
}
