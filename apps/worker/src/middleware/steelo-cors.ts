import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

/**
 * STEELO 専用 CORS ミドルウェア。
 *
 * 既存 Worker の `app.use('*', cors({ origin: '*' }))` は STEELO 系には適用しない
 * （PII / 支払情報を扱うため）。本ミドルウェアは環境変数 STEELO_WEB_ORIGINS
 * （カンマ区切り）に列挙された origin のみを許可する。
 *
 * Cloudflare Access が前段にあることを前提にした多層防御の1層。
 *
 * 適用ルート:
 *   /api/(drivers|driver-aliases|driver-deductions|excel-imports|payment-summaries|audit-logs)*
 */
export function steeloCors() {
  return async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const origin = c.req.header('Origin') ?? '';
    const allowed = parseAllowedOrigins(c.env.STEELO_WEB_ORIGINS);

    // Same-origin / non-CORS（Origin ヘッダなし）はそのまま通す
    if (!origin) {
      return next();
    }

    if (!allowed.has(origin)) {
      return c.json(
        { success: false, error: 'Forbidden: origin not allowed' },
        403
      );
    }

    // Preflight
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, c.req.header('Access-Control-Request-Headers')),
      });
    }

    await next();

    // 通常レスポンスにも CORS ヘッダを付与
    const headers = corsHeaders(origin);
    for (const [k, v] of Object.entries(headers)) {
      c.res.headers.set(k, v);
    }
  };
}

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

function corsHeaders(origin: string, requestHeaders?: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': requestHeaders ?? 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export const STEELO_ROUTE_PATTERN =
  '/api/:resource{drivers|driver-aliases|driver-deductions|excel-imports|payment-summaries|audit-logs}/*';
