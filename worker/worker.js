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
const ALLOWED_ORIGINS = ["https://adatchan.github.io"];

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
