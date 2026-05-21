// STEELO Phase 3 F9: notification-dispatcher 本体の統合テスト
//
// Codex full review MEDIUM #11 反映:
//   claim / cooldown / stale recovery 単体テストは phase3-integration.test.ts に
//   あるが、dispatcher 本体の max_attempts / not_enabled / target_missing /
//   4xx/5xx requeue / audit.payload_json の結合カバレッジを追加する。
//
// fetch をモックして LINE API レスポンスを擬似し、dispatcher の振る舞いを検証する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueueDelivery,
  updateNotificationSettings,
} from '@line-crm/db';
import { createSqliteD1, type SqliteD1 } from '@line-crm/db/testing';
import { runNotificationDispatcher } from './notification-dispatcher.js';

let h: SqliteD1;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h = createSqliteD1();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  h.close();
  vi.unstubAllGlobals();
});

const VALID_TARGET = 'U1234567890abcdef1234567890abcdef'; // 33 文字
const ENV_DEFAULTS = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
};

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: h.db,
    ...ENV_DEFAULTS,
    ...overrides,
  } as unknown as Parameters<typeof runNotificationDispatcher>[0];
}

async function setup(opts: {
  targetId?: string | null;
  enabledEvents?: string[];
} = {}) {
  await updateNotificationSettings(h.db, {
    lineTargetId: opts.targetId === undefined ? VALID_TARGET : opts.targetId,
    enabledEvents:
      opts.enabledEvents ?? ['reconciliation_completed', 'monthly_reminder'],
  });
}

async function enqueueReconciliation(jobId: string) {
  await enqueueDelivery(h.db, {
    idempotencyKey: `reconciliation_completed:${jobId}`,
    eventType: 'reconciliation_completed',
    eventPayloadJson: JSON.stringify({
      period: '2026-05',
      matched: 1,
      clientOnly: 0,
      dispatchOnly: 0,
      warningCounts: {},
      adminUrl: 'https://admin.example.com/reconciliations',
    }),
  });
}

describe('runNotificationDispatcher', () => {
  it('正常系: pending → 200 → sent + audit', async () => {
    await setup();
    await enqueueReconciliation('job-1');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    // line-notifier の retry sleep をスキップするため sleep をモック
    // (notification-dispatcher は sleep を直接制御しないが、line-notifier 内部の
    // 5xx retry 時の sleep は実時間がかかるので、ここは 200 で 1 回成功させる)

    const result = await runNotificationDispatcher(makeEnv());
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // status=sent に倒れている
    const row = await h.db
      .prepare(`SELECT status, sent_at FROM notification_deliveries`)
      .first<{ status: string; sent_at: string | null }>();
    expect(row?.status).toBe('sent');
    expect(row?.sent_at).not.toBeNull();

    // audit に notification_sent が記録
    const audit = await h.db
      .prepare(
        `SELECT action, payload_json FROM audit_logs WHERE action = 'notification_sent'`,
      )
      .first<{ action: string; payload_json: string }>();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.payload_json).event_type).toBe('reconciliation_completed');
  });

  it('target_id 未設定: 何も claim せず終了', async () => {
    await setup({ targetId: null });
    await enqueueReconciliation('job-1');
    const result = await runNotificationDispatcher(makeEnv());
    expect(result.claimed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // pending のまま残る
    const row = await h.db
      .prepare(`SELECT status FROM notification_deliveries`)
      .first<{ status: string }>();
    expect(row?.status).toBe('pending');
  });

  it('LINE_CHANNEL_ACCESS_TOKEN 未設定: 何も claim せず終了', async () => {
    await setup();
    await enqueueReconciliation('job-1');
    const result = await runNotificationDispatcher(
      makeEnv({ LINE_CHANNEL_ACCESS_TOKEN: '' }),
    );
    expect(result.claimed).toBe(0);
  });

  it('enabled_events に含まれない event_type は skipped + audit', async () => {
    await setup({ enabledEvents: ['monthly_reminder'] });
    // reconciliation_completed を enqueue (enabled でない)
    await enqueueReconciliation('job-1');

    const result = await runNotificationDispatcher(makeEnv());
    expect(result.claimed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const row = await h.db
      .prepare(`SELECT status, last_error FROM notification_deliveries`)
      .first<{ status: string; last_error: string }>();
    expect(row?.status).toBe('skipped');
    expect(row?.last_error).toContain('not enabled');

    const audit = await h.db
      .prepare(
        `SELECT action, payload_json FROM audit_logs WHERE action = 'notification_skipped'`,
      )
      .first<{ action: string; payload_json: string }>();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.payload_json).reason).toBe('not_enabled');
  });

  it('4xx 即 failed + audit + last_error 記録', async () => {
    await setup();
    await enqueueReconciliation('job-1');
    fetchMock.mockResolvedValue(
      new Response('{"message":"invalid token"}', { status: 401 }),
    );

    const result = await runNotificationDispatcher(makeEnv());
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx は retry しない

    const row = await h.db
      .prepare(`SELECT status, last_error FROM notification_deliveries`)
      .first<{ status: string; last_error: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('401');
    expect(row?.last_error).not.toContain('test-token'); // token が漏れていない

    const audit = await h.db
      .prepare(
        `SELECT action, payload_json FROM audit_logs WHERE action = 'notification_failed'`,
      )
      .first<{ action: string; payload_json: string }>();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.payload_json).reason).toBe('4xx');
  });

  it('5xx 全て失敗 → requeue (status=pending、attempt_count++、next_retry_at セット)', async () => {
    await setup();
    await enqueueReconciliation('job-1');
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));

    const result = await runNotificationDispatcher(makeEnv());
    expect(result.requeued).toBe(1);
    expect(result.sent).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 5xx は 3 回 retry

    const row = await h.db
      .prepare(
        `SELECT status, attempt_count, next_retry_at, last_error FROM notification_deliveries`,
      )
      .first<{
        status: string;
        attempt_count: number;
        next_retry_at: string | null;
        last_error: string;
      }>();
    expect(row?.status).toBe('pending');
    expect(row?.attempt_count).toBe(1);
    expect(row?.next_retry_at).not.toBeNull();
    expect(row?.last_error).toContain('503');
  });

  it('attempt_count >= 6 で claim 時点で failed', async () => {
    await setup();
    await enqueueReconciliation('job-1');
    // attempt_count を 6 に直接セット (テスト用ショートカット)
    await h.db
      .prepare(
        `UPDATE notification_deliveries SET attempt_count = 6 WHERE event_type = 'reconciliation_completed'`,
      )
      .run();

    const result = await runNotificationDispatcher(makeEnv());
    expect(result.failed).toBe(1);
    expect(result.claimed).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // claim 時点で failed なので fetch せず

    const row = await h.db
      .prepare(`SELECT status, last_error FROM notification_deliveries`)
      .first<{ status: string; last_error: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('attempt_count exceeded');

    const audit = await h.db
      .prepare(
        `SELECT payload_json FROM audit_logs WHERE action = 'notification_failed'`,
      )
      .first<{ payload_json: string }>();
    expect(JSON.parse(audit!.payload_json).reason).toBe('max_attempts');
  });

  it('複数 pending を 1 invocation で batch 処理 (最大 10 件)', async () => {
    await setup();
    for (let i = 0; i < 3; i++) {
      await enqueueReconciliation(`job-${i}`);
    }
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const result = await runNotificationDispatcher(makeEnv());
    expect(result.claimed).toBe(3);
    expect(result.sent).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
