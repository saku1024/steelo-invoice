import { describe, expect, test, vi } from 'vitest';
import type { Context } from 'hono';
import { recordAudit, recordSystemAudit, safeAudit } from './audit.js';
import type { Env } from '../index.js';

type Captured = {
  sql?: string;
  bindings?: unknown[];
};

function mockDb(): { db: D1Database; captured: Captured } {
  const captured: Captured = {};
  const stmt = {
    bind: (...args: unknown[]) => {
      captured.bindings = args;
      return {
        run: async () => ({ success: true, meta: {} as Record<string, unknown> }),
      };
    },
  };
  const db = {
    prepare: (sql: string) => {
      captured.sql = sql;
      return stmt;
    },
  } as unknown as D1Database;
  return { db, captured };
}

function mockCtx(headers: Record<string, string> = {}): Context<Env> {
  return {
    get: (key: string) => {
      if (key === 'staff') {
        return { id: 'staff-1', name: 'Alice', role: 'admin' as const };
      }
      return undefined;
    },
    req: {
      header: (name: string) => headers[name],
    },
  } as unknown as Context<Env>;
}

describe('recordAudit', () => {
  test('staff・IP・UA を含めて audit_logs に INSERT する', async () => {
    const { db, captured } = mockDb();
    const ctx = mockCtx({
      'CF-Connecting-IP': '203.0.113.1',
      'User-Agent': 'TestAgent/1.0',
    });

    await recordAudit(db, ctx, {
      action: 'import_confirm',
      resourceType: 'import_batch',
      resourceId: 'batch-1',
      payload: { period: '2026-05', overwrite: false },
    });

    expect(captured.sql).toContain('INSERT INTO audit_logs');
    expect(captured.bindings).toBeDefined();
    const b = captured.bindings as unknown[];
    // [id, actor_id, actor_name, action, resource_type, resource_id, payload_json, ip, ua]
    expect(b[1]).toBe('staff-1');
    expect(b[2]).toBe('Alice');
    expect(b[3]).toBe('import_confirm');
    expect(b[4]).toBe('import_batch');
    expect(b[5]).toBe('batch-1');
    expect(JSON.parse(b[6] as string)).toEqual({ period: '2026-05', overwrite: false });
    expect(b[7]).toBe('203.0.113.1');
    expect(b[8]).toBe('TestAgent/1.0');
  });

  test('staff variable 未設定時は unknown actor を使う', async () => {
    const { db, captured } = mockDb();
    const ctx = {
      get: () => undefined,
      req: { header: () => undefined },
    } as unknown as Context<Env>;

    await recordAudit(db, ctx, {
      action: 'driver_create',
      resourceType: 'driver',
      resourceId: 'd-1',
    });

    const b = captured.bindings as unknown[];
    expect(b[1]).toBe('unknown');
    expect(b[2]).toBe('unknown');
    expect(b[6]).toBeNull(); // payload なし
    expect(b[7]).toBeNull(); // IP なし
    expect(b[8]).toBeNull(); // UA なし
  });

  test('X-Forwarded-For から先頭 IP を抽出する', async () => {
    const { db, captured } = mockDb();
    const ctx = mockCtx({
      'X-Forwarded-For': '203.0.113.42, 10.0.0.1, 192.168.1.1',
    });

    await recordAudit(db, ctx, {
      action: 'payment_generate',
      resourceType: 'payment_summary',
      resourceId: 's-1',
    });

    const b = captured.bindings as unknown[];
    expect(b[7]).toBe('203.0.113.42');
  });
});

describe('recordSystemAudit', () => {
  test('Context 不要、system actor で INSERT する', async () => {
    const { db, captured } = mockDb();
    await recordSystemAudit(db, {
      action: 'webhook_save_failed',
      resourceType: 'line_message',
      resourceId: 'msg-1',
      payload: { error: 'D1 unavailable' },
    });

    const b = captured.bindings as unknown[];
    expect(b[1]).toBe('system');
    expect(b[2]).toBe('system');
    expect(b[3]).toBe('webhook_save_failed');
    expect(JSON.parse(b[6] as string)).toEqual({ error: 'D1 unavailable' });
  });
});

describe('safeAudit', () => {
  test('内部の recordAudit 成功時は通常通り完了する', async () => {
    const { db, captured } = mockDb();
    const ctx = mockCtx({ 'CF-Connecting-IP': '203.0.113.5' });
    await safeAudit(db, ctx, {
      action: 'driver_create',
      resourceType: 'driver',
      resourceId: 'd-1',
    });
    expect(captured.sql).toContain('INSERT INTO audit_logs');
  });

  test('内部の recordAudit が throw しても自身は throw しない（本処理の 500 を防ぐ）', async () => {
    const failingDb = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = mockCtx();
    await expect(
      safeAudit(failingDb, ctx, {
        action: 'driver_create',
        resourceType: 'driver',
        resourceId: 'd-1',
      })
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[audit-soft-fail]',
      'driver_create',
      'driver',
      'd-1',
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });
});
