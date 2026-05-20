import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { steeloCors } from './steelo-cors.js';
import type { Env } from '../index.js';

function appWithOrigins(origins: string | undefined): Hono<Env> {
  const app = new Hono<Env>();
  app.use('/api/drivers/*', steeloCors());
  app.get('/api/drivers', (c) => c.json({ ok: true }));
  return app;
}

async function request(
  app: Hono<Env>,
  url: string,
  init: RequestInit & { origin?: string },
  env: Env['Bindings']
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.origin) headers.set('Origin', init.origin);
  return app.fetch(new Request(url, { ...init, headers }), env);
}

const ALLOWED = 'https://admin.example.com';
const OTHER = 'https://attacker.example.com';
const ENV_ALLOWED = { STEELO_WEB_ORIGINS: ALLOWED } as Env['Bindings'];
const ENV_MULTI = {
  STEELO_WEB_ORIGINS: `${ALLOWED},https://staging.example.com`,
} as Env['Bindings'];
const ENV_EMPTY = { STEELO_WEB_ORIGINS: '' } as Env['Bindings'];

describe('steeloCors', () => {
  test('許可 origin からは 200 + CORS ヘッダ', async () => {
    const app = appWithOrigins(ALLOWED);
    const res = await request(app, 'http://w/api/drivers', { origin: ALLOWED }, ENV_ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  test('未許可 origin は 403', async () => {
    const app = appWithOrigins(ALLOWED);
    const res = await request(app, 'http://w/api/drivers', { origin: OTHER }, ENV_ALLOWED);
    expect(res.status).toBe(403);
  });

  test('Origin ヘッダなし（same-origin）はそのまま通す', async () => {
    const app = appWithOrigins(ALLOWED);
    const res = await request(app, 'http://w/api/drivers', {}, ENV_ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('preflight OPTIONS は 204 を返し本体処理しない', async () => {
    const app = appWithOrigins(ALLOWED);
    const res = await request(
      app,
      'http://w/api/drivers',
      {
        method: 'OPTIONS',
        origin: ALLOWED,
        headers: { 'Access-Control-Request-Headers': 'Authorization, Content-Type' },
      },
      ENV_ALLOWED
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  test('カンマ区切り複数 origin を許可', async () => {
    const app = appWithOrigins(ENV_MULTI.STEELO_WEB_ORIGINS);
    const res = await request(
      app,
      'http://w/api/drivers',
      { origin: 'https://staging.example.com' },
      ENV_MULTI
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.example.com');
  });

  test('STEELO_WEB_ORIGINS が空のときは Origin 付きで全て 403', async () => {
    const app = appWithOrigins('');
    const res = await request(app, 'http://w/api/drivers', { origin: ALLOWED }, ENV_EMPTY);
    expect(res.status).toBe(403);
  });
});
