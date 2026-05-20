/**
 * Cloudflare Worker: moj.go.jp 中継プロキシ
 *
 * クライアント（ブラウザ）から ?url=<URL> 形式で呼び出すと、
 * moj.go.jp 配下の HTML / PDF を取得して CORS ヘッダ付きで返す。
 *
 * セキュリティ:
 *   - moj.go.jp 配下の URL のみ許可（オープンプロキシ化防止）
 *   - レスポンスは Content-Type をそのまま中継
 *
 * デプロイ:
 *   1. https://dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. このファイルの内容を貼り付けて Deploy
 *   3. 払い出された URL（例: https://moj-proxy.your-name.workers.dev）を
 *      web/app.js の WORKER_URL に設定
 */

const ALLOWED_PREFIX = "https://www.moj.go.jp/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");

    if (!target) {
      return jsonError("Missing 'url' query parameter.", 400);
    }
    if (!target.startsWith(ALLOWED_PREFIX)) {
      return jsonError(
        `Only ${ALLOWED_PREFIX}* is allowed (got: ${target}).`,
        403,
      );
    }

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
      });

      const headers = new Headers();
      const contentType = upstream.headers.get("Content-Type");
      if (contentType) headers.set("Content-Type", contentType);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      // ブラウザ側でキャッシュしてもらう
      headers.set("Cache-Control", "public, max-age=3600");

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (e) {
      return jsonError(`Fetch failed: ${e.message}`, 502);
    }
  },
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}
