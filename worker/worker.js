/**
 * Cloudflare Worker: moj.go.jp 中継プロキシ
 *
 * クライアント（ブラウザ）から ?url=<URL> 形式で呼び出すと、
 * moj.go.jp 配下の HTML / PDF を取得して CORS ヘッダ付きで返す。
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
 *   3. 新規作成時は払い出された URL を web/moj.js の WORKER_URL に設定
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
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // 許可されたブラウザ Origin にのみ ACAO を反映（サーバー間は CORS 不要）
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export default {
  async fetch(request) {
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

    // 過去問PDFは一度公表されたら不変なので、Cloudflare のエッジに長期間
    // キャッシュして法務省 origin への再取得を避ける（利用者をまたいで同じ
    // PDFは実質1回しか取りに行かない＝負荷集中・ブロックリスクを抑える）。
    // HTMLは新資料の掲載を反映するため短め。エラー応答はキャッシュしない。
    const isPdf = /\.pdf(?:$|\?)/i.test(target);
    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "ja,en;q=0.9",
        },
        // 法務省サイトは redirect を返すことがあるので follow
        redirect: "follow",
        // Cloudflare エッジキャッシュ。成功時のみ保持し、3xx/4xx/5xx は
        // 保持しない（未掲載404や一時障害を焼き付けないため）。
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

      const headers = new Headers();
      const contentType = upstream.headers.get("Content-Type");
      if (contentType) headers.set("Content-Type", contentType);
      for (const [k, v] of Object.entries(corsHeaders(origin)))
        headers.set(k, v);
      // ブラウザ側にもキャッシュさせる（PDFは不変なので長期＋immutable、
      // HTMLは短め）
      headers.set(
        "Cache-Control",
        isPdf ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      );
      // エッジの HIT/MISS を確認できるよう中継する（運用時の検証用）
      const cacheStatus = upstream.headers.get("cf-cache-status");
      if (cacheStatus) headers.set("X-MOJ-Cache", cacheStatus);

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (e) {
      return jsonError(`Fetch failed: ${e.message}`, 502, origin);
    }
  },
};

function jsonError(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}
