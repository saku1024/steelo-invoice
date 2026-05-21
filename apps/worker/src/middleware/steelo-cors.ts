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
/**
 * Hono の `app.use('*', cors({ origin: '*' }))` を STEELO 系パスでは
 * 適用しないようにするためのパスプレフィックス。
 * 既存 LINE Harness のグローバル CORS は STEELO の origin 制限を上書き
 * してしまうので、グローバル CORS 側でこのプレフィックスを skip する。
 */
export const STEELO_PATH_PREFIXES = [
  '/api/drivers',
  '/api/driver-aliases',
  '/api/driver-deductions',
  '/api/dispatch-records',
  '/api/excel-imports',
  '/api/payment-summaries',
  '/api/line-messages',
  '/api/audit-logs',
  // Phase 2
  '/api/reconciliations',
  '/api/llm-parse',
  // Phase 3
  '/api/reports',
  '/api/notification-settings',
  '/api/anomaly-baselines',
] as const;

export function isSteeloPath(pathname: string): boolean {
  return STEELO_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export function steeloCors() {
  return async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const origin = c.req.header('Origin') ?? '';
    const allowed = parseAllowedOrigins(c.env.STEELO_WEB_ORIGINS);
    const method = c.req.method;

    // Same-origin / non-CORS（Origin ヘッダなし）はそのまま通す
    if (!origin) {
      return next();
    }

    if (!allowed.has(origin)) {
      // 既存グローバル cors() がこの応答を上書きしないよう、
      // ここで明示的に Vary: Origin を設定し short-circuit する。
      return new Response(
        JSON.stringify({ success: false, error: 'Forbidden: origin not allowed' }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            Vary: 'Origin',
          },
        }
      );
    }

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, c.req.header('Access-Control-Request-Headers')),
      });
    }

    await next();

    // 通常レスポンスにも CORS ヘッダを付与（上書き）
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
