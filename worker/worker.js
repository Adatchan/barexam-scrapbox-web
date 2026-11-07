/**
 * Cloudflare Worker: moj.go.jp 中継プロキシ（PDF は R2 に永続キャッシュ）
 *
 * クライアント（ブラウザ）から ?url=<URL> 形式で呼び出すと、
 * moj.go.jp 配下の HTML / PDF を取得して CORS ヘッダ付きで返す。
 *
 * キャッシュ方針:
 *   - PDF: Cloudflare R2 に永続保存する。過去問PDFは一度公表されたら不変なので、
 *     初回だけ法務省 origin から取得して R2 に保存し、以降は R2 から配信する。
 *     エッジキャッシュ（cf.cacheTtl）と違い R2 は LRU で追い出されないため、
 *     「一度落としたPDFは二度と法務省へ取りに行かない」を保証できる。
 *   - HTML: 新資料の掲載を反映するためエッジに短期（1時間）キャッシュのみ。
 *     R2 には保存しない（内容が更新されるため）。
 *   - エラー応答はキャッシュも R2 保存もしない。
 *
 * 必要なバインディング:
 *   - R2 バケットを binding 名 MOJ_PDF で割り当てること。
 *     ダッシュボード → 対象 Worker → Settings → Variables and Secrets の
 *     「R2 Bucket Bindings」で Variable name = MOJ_PDF, Bucket = 作成した
 *     バケット（例: moj-pdf-cache）を選んで保存する。
 *
 * セキュリティ:
 *   - moj.go.jp 配下の URL のみ許可（オープンプロキシ化防止）
 *   - Origin 制限: 他サイトからのブラウザ埋め込み流用を拒否する。
 *     ただし Origin ヘッダを送らないサーバー間アクセス（検証スクリプト
 *     scripts/*.mjs や GitHub Actions の Node 実行）は許可する。
 *     ※ curl 等は Origin を偽装できるため完全な防御ではない。大量
 *       アクセス対策は Cloudflare のレート制限で別途行うこと。
 *   - レスポンスは Content-Type をそのまま中継
 *
 * デプロイ:
 *   1. https://dash.cloudflare.com → Workers & Pages → 対象 Worker
 *   2. このファイルの内容を貼り付けて Deploy（Quick edit / Save and deploy）
 *   3. 上記 R2 バインディング（MOJ_PDF）を必ず設定しておくこと。
 *
 * 公開先を変えたら ALLOWED_ORIGINS を更新すること。
 */

const ALLOWED_PREFIX = "https://www.moj.go.jp/";

// ブラウザからの利用を許可するオリジン（公開先 + ローカル開発）
const ALLOWED_ORIGINS = [
  "https://barexam.y-adachi.com", // 公開先（Cloudflare Pages）
  "https://adatchan.github.io", // 旧公開先（GitHub Pages。転送用に残す）
];

export function isOriginAllowed(origin) {
  if (!origin) return true; // Origin なし（サーバー間・検証スクリプト）は許可
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // ブラウザの JS から取得元（R2HIT / エッジHIT / origin取得）を読めるよう公開する
    "Access-Control-Expose-Headers": "X-MOJ-Cache",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // 許可されたブラウザ Origin にのみ ACAO を反映（サーバー間は CORS 不要）
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// R2 のオブジェクトキー。ALLOWED_PREFIX で www.moj.go.jp に限定済みなので
// pathname だけで一意。先頭スラッシュを除いて "content/001234.pdf" のような形に。
function r2KeyFor(target) {
  return new URL(target).pathname.replace(/^\/+/, "");
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    if (!isOriginAllowed(origin)) {
      return jsonError("このエンドポイントの利用は許可されていません。", 403, origin);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const reqUrl = new URL(request.url);

    // ── ダウンロード数の計測・集計（stats）─────────────────────────────────
    if (reqUrl.pathname === "/hit") return handleHit(request, env, origin, reqUrl);
    if (STATS_PATHS.has(reqUrl.pathname))
      return handleStats(request, env, ctx, reqUrl);

    const target = reqUrl.searchParams.get("url");

    if (!target) {
      return jsonError("Missing 'url' query parameter.", 400, origin);
    }
    if (!target.startsWith(ALLOWED_PREFIX)) {
      return jsonError(
        `Only ${ALLOWED_PREFIX}* is allowed (got: ${target}).`,
        403,
        origin,
      );
    }

    const isPdf = /\.pdf(?:$|\?)/i.test(target);

    // ── PDF: R2 永続キャッシュを優先 ───────────────────────────────────────
    if (isPdf && env.MOJ_PDF) {
      const key = r2KeyFor(target);
      const cached = await env.MOJ_PDF.get(key);
      if (cached) {
        // R2 から配信（法務省へは行かない・永続）
        const headers = new Headers();
        const ct = cached.httpMetadata?.contentType || "application/pdf";
        headers.set("Content-Type", ct);
        for (const [k, v] of Object.entries(corsHeaders(origin)))
          headers.set(k, v);
        // ブラウザ側は短期キャッシュのみ（端末にPDFを溜め込まない）。法務省への
        // 再取得抑制は R2 が担うので、ブラウザ短期でも影響しない。
        headers.set("Cache-Control", "public, max-age=3600");
        headers.set("X-MOJ-Cache", "R2HIT");
        return new Response(cached.body, { status: 200, headers });
      }

      // R2 ミス: 法務省から取得して保存してから返す。
      try {
        const upstream = await fetchUpstream(target, isPdf);
        const ok = upstream.status >= 200 && upstream.status < 300;
        const contentType =
          upstream.headers.get("Content-Type") || "application/pdf";

        if (ok) {
          // 本文を一度バッファし、R2 保存とクライアント返却の両方に使う。
          const buf = await upstream.arrayBuffer();
          // 保存はレスポンス送出を遅らせないよう waitUntil に委ねる。
          ctx.waitUntil(
            env.MOJ_PDF.put(key, buf, {
              httpMetadata: { contentType },
            }),
          );
          const headers = new Headers();
          headers.set("Content-Type", contentType);
          for (const [k, v] of Object.entries(corsHeaders(origin)))
            headers.set(k, v);
          headers.set("Cache-Control", "public, max-age=3600");
          // 初回（法務省へ取りに行った）であることを示す。
          headers.set("X-MOJ-Cache", "MISS");
          return new Response(buf, { status: 200, headers });
        }

        // 非2xx（未掲載404・一時障害等）は保存せずそのまま中継。
        return relay(upstream, origin, false);
      } catch (e) {
        return jsonError(`Fetch failed: ${e.message}`, 502, origin);
      }
    }

    // ── HTML（および R2 未設定時の PDF）: エッジキャッシュで中継 ───────────
    try {
      const upstream = await fetchUpstream(target, isPdf);
      return relay(upstream, origin, true);
    } catch (e) {
      return jsonError(`Fetch failed: ${e.message}`, 502, origin);
    }
  },
};

// 法務省 origin から取得。PDF は念のためエッジにも長期キャッシュ（R2 未設定の
// フォールバック用）、HTML は短期。成功時のみ保持し 3xx/4xx/5xx は保持しない。
function fetchUpstream(target, isPdf) {
  return fetch(target, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "ja,en;q=0.9",
    },
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        "200-299": isPdf ? 31536000 : 3600,
        "300-399": 0,
        "400-499": 0,
        "500-599": 0,
      },
    },
  });
}

// upstream レスポンスを CORS ヘッダ付きで中継する（本文をストリームのまま流す）。
function relay(upstream, origin, allowBrowserCache) {
  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);

  const ok = upstream.status >= 200 && upstream.status < 300;
  headers.set(
    "Cache-Control",
    ok && allowBrowserCache ? "public, max-age=3600" : "no-store",
  );
  const cacheStatus = upstream.headers.get("cf-cache-status");
  if (cacheStatus) headers.set("X-MOJ-Cache", cacheStatus);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function jsonError(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

// =============================================================================
// 月間ダウンロード数の計測
//
//   POST /hit?k=<種類>   保存1回ごとに ui.js が送る。1回=R2 に空オブジェクト1個
//                        （_stats/v1/<YYYY-MM>/<種類>/<時刻>-<乱数>）。読み書きの
//                        競合で数え落とさないよう、カウンタの加算ではなく1件1個で記録する。
//                        記録するのは種類と時刻だけ（IP・UA・ファイル名は保存しない）。
//   GET  /stats          月別のダウンロード数（HTML の表）。← 共有用のリンク
//   GET  /stats.json     同じ集計の JSON
//   GET  /badge.json     今月の件数（shields.io の endpoint バッジ形式）
//
// 月は日本時間で区切る。集計は R2 の list（1回1000件）で数える。締まった月は
// _stats/summary/<YYYY-MM>.json に結果を保存して以後は数え直さない。集計応答は
// エッジに 5 分キャッシュする（閲覧のたびに list しない）。
// 種類 = <ページ>-<試験>-<形式>
//   ページ: ronbun（論文式コンバーター） / tantou（短答ダウンローダー）
//   試験  : shihou（司法試験） / yobi（予備試験）
//   形式  : pdf / zip / md / txt
// =============================================================================
const STATS_PREFIX = "_stats/v1/";
const SUMMARY_PREFIX = "_stats/summary/";
const STATS_PATHS = new Set(["/stats", "/stats.json", "/badge.json"]);
const KIND_RE = /^(ronbun|tantou)-(shihou|yobi)-(pdf|zip|md|txt)$/;
// 計測を受け付けるのは公開先のページからの送信だけ（ローカル開発・旧公開先は数えない）
const HIT_ORIGIN = "https://barexam.y-adachi.com";
const STATS_MONTHS = 24; // 表示する最大月数
const STATS_CACHE_SEC = 300;

// 日本時間の "YYYY-MM"。offset で前後の月（-1 = 先月）。
export function jstMonth(date = new Date(), offset = 0) {
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() + offset;
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
}

async function handleHit(request, env, origin, reqUrl) {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST")
    return jsonError("POST only.", 405, origin);
  if (origin !== HIT_ORIGIN) return jsonError("Forbidden origin.", 403, origin);
  const kind = reqUrl.searchParams.get("k") || "";
  if (!KIND_RE.test(kind)) return jsonError("Unknown kind.", 400, origin);
  if (!env.MOJ_PDF) return jsonError("Storage not configured.", 503, origin);

  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const key = `${STATS_PREFIX}${jstMonth()}/${kind}/${Date.now()}-${rand}`;
  await env.MOJ_PDF.put(key, new Uint8Array(0));
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(origin), "Cache-Control": "no-store" },
  });
}

// 1か月分を数える: { month, total, kinds: { <種類>: 件数 } }
async function countMonth(env, month) {
  const kinds = {};
  let total = 0;
  let cursor;
  do {
    const page = await env.MOJ_PDF.list({
      prefix: `${STATS_PREFIX}${month}/`,
      cursor,
      limit: 1000,
    });
    for (const obj of page.objects) {
      const kind = obj.key.slice(STATS_PREFIX.length + month.length + 1).split("/")[0];
      kinds[kind] = (kinds[kind] || 0) + 1;
      total++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { month, total, kinds };
}

// 締まった月は保存済みの集計を使い、無ければ数えて保存する。今月は毎回数える。
async function monthStats(env, month, current) {
  if (month !== current) {
    const saved = await env.MOJ_PDF.get(`${SUMMARY_PREFIX}${month}.json`);
    if (saved) return saved.json();
  }
  const s = await countMonth(env, month);
  if (month !== current)
    await env.MOJ_PDF.put(`${SUMMARY_PREFIX}${month}.json`, JSON.stringify(s), {
      httpMetadata: { contentType: "application/json" },
    });
  return s;
}

export async function collectStats(env, now = new Date()) {
  const current = jstMonth(now);
  const months = [];
  for (let i = 0; i < STATS_MONTHS; i++) {
    const s = await monthStats(env, jstMonth(now, -i), current);
    months.push(s);
  }
  // 計測開始前の月（古い側の 0 件）は表示しない。今月は 0 件でも残す。
  while (months.length > 1 && months[months.length - 1].total === 0) months.pop();
  return { generatedAt: now.toISOString(), current, months };
}

async function handleStats(request, env, ctx, reqUrl) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return jsonError("GET only.", 405, null);
  if (!env.MOJ_PDF) return jsonError("Storage not configured.", 503, null);

  const cache = caches.default;
  const cacheKey = new Request(reqUrl.origin + reqUrl.pathname, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const stats = await collectStats(env);
  let res;
  if (reqUrl.pathname === "/stats.json") {
    res = new Response(JSON.stringify(stats, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } else if (reqUrl.pathname === "/badge.json") {
    const n = stats.months[0]?.total ?? 0;
    res = new Response(
      JSON.stringify({
        schemaVersion: 1,
        label: "今月のダウンロード",
        message: `${n.toLocaleString("ja-JP")} 件`,
        color: "1f5bd6",
      }),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } else {
    res = new Response(renderStatsHtml(stats), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
  }
  res.headers.set("Cache-Control", `public, max-age=${STATS_CACHE_SEC}`);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// 集計表の列: [見出し, 集計に含める種類の判定]
const STATS_COLUMNS = [
  ["論文式", (k) => k.startsWith("ronbun-")],
  ["短答式", (k) => k.startsWith("tantou-")],
  ["司法試験", (k) => k.includes("-shihou-")],
  ["予備試験", (k) => k.includes("-yobi-")],
  ["PDF", (k) => k.endsWith("-pdf")],
  ["zip", (k) => k.endsWith("-zip")],
  ["LLM用 .md", (k) => k.endsWith("-md")],
  [".txt", (k) => k.endsWith("-txt")],
];

function sumKinds(kinds, pred) {
  let n = 0;
  for (const [k, v] of Object.entries(kinds || {})) if (pred(k)) n += v;
  return n;
}

export function renderStatsHtml(stats) {
  const fmt = (n) => n.toLocaleString("ja-JP");
  const label = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
  const max = Math.max(1, ...stats.months.map((m) => m.total));
  const all = stats.months.reduce((a, m) => a + m.total, 0);
  const rows = stats.months
    .map((m) => {
      const cur = m.month === stats.current;
      const cells = STATS_COLUMNS.map(
        ([, pred]) => `<td>${fmt(sumKinds(m.kinds, pred))}</td>`,
      ).join("");
      const w = ((m.total / max) * 100).toFixed(1);
      return (
        `<tr${cur ? ' class="cur"' : ""}><th scope="row">${label(m.month)}` +
        `${cur ? '<span class="tag">集計中</span>' : ""}</th>` +
        `<td class="total"><span class="bar" style="width:${w}%"></span>` +
        `<span class="n">${fmt(m.total)}</span></td>${cells}</tr>`
      );
    })
    .join("\n");
  const heads = STATS_COLUMNS.map(([h]) => `<th scope="col">${h}</th>`).join("");
  const updated = new Date(stats.generatedAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
  const thisMonth = stats.months[0]?.total ?? 0;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>しほしけコンバーター 月間ダウンロード数</title>
<style>
  :root { --ink:#161b26; --muted:#687085; --line:#e6e8ee; --primary:#1f5bd6; --soft:#e5eefc; }
  body { margin:0; background:#e7e5df; color:var(--ink);
    font-family:"BIZ UDPGothic","BIZ UDGothic","Hiragino Sans","Noto Sans JP",sans-serif; }
  main { max-width:960px; margin:24px auto; background:#fff; border-radius:12px; padding:24px 28px; }
  h1 { font-size:1.3rem; margin:0 0 4px; }
  .lead { color:var(--muted); margin:0 0 20px; font-size:.9rem; }
  .kpi { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
  .kpi div { background:#f5f7fa; border-radius:10px; padding:12px 18px; min-width:160px; }
  .kpi b { display:block; font-size:1.8rem; color:var(--primary); font-variant-numeric:tabular-nums; }
  .kpi span { color:var(--muted); font-size:.85rem; }
  .wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; font-variant-numeric:tabular-nums; }
  th, td { border-bottom:1px solid var(--line); padding:8px 10px; text-align:right; white-space:nowrap; }
  thead th { color:var(--muted); font-weight:normal; font-size:.8rem; }
  tbody th { text-align:left; font-weight:normal; }
  td.total { position:relative; min-width:140px; font-weight:bold; }
  td.total .bar { position:absolute; left:0; top:6px; bottom:6px; background:var(--soft); border-radius:4px; }
  td.total .n { position:relative; }
  tr.cur th { font-weight:bold; }
  .tag { margin-left:6px; font-size:.7rem; color:var(--primary); background:var(--soft); border-radius:4px; padding:1px 6px; }
  .note { color:var(--muted); font-size:.8rem; line-height:1.7; margin-top:20px; }
  a { color:var(--primary); }
</style>
</head>
<body>
<main>
  <h1>しほしけコンバーター 月間ダウンロード数</h1>
  <p class="lead">最終集計 ${updated}（日本時間・約5分ごとに更新）</p>
  <div class="kpi">
    <div><b>${fmt(thisMonth)}</b><span>今月（${label(stats.current)}）</span></div>
    <div><b>${fmt(stats.months[1]?.total ?? 0)}</b><span>先月</span></div>
    <div><b>${fmt(all)}</b><span>表示期間の合計</span></div>
  </div>
  <div class="wrap">
  <table>
    <thead><tr><th scope="col" style="text-align:left">月</th><th scope="col">合計</th>${heads}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
  <p class="note">
    ダウンロード数 = <a href="https://barexam.y-adachi.com/">しほしけコンバーター</a>・
    <a href="https://barexam.y-adachi.com/tantou">しほしけ短答ダウンローダー</a>で
    ファイルを保存した回数（抜粋PDF・一式zip・LLM用 .md・.txt）。テキストのコピーは含みません。<br>
    月は日本時間で区切ります。端末や利用者を識別する情報は記録していません。
    JSON: <a href="/stats.json">/stats.json</a>
  </p>
</main>
</body>
</html>`;
}
