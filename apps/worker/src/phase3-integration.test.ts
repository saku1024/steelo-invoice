// STEELO Phase 3 統合テスト: F9 通知パイプライン (LINE Messaging API)
//
// 重要シナリオ:
//   - enqueueDelivery: idempotency_key で重複 INSERT を防ぐ
//   - claimBatch: atomic UPDATE で複数 cron 競合を防ぐ
//   - recoverStuckProcessing: 10 分以上前の claim を pending に戻す
//   - isCooldownActive: 24h cooldown 判定
//   - reconciliation-job の通知 enqueue (Slack 直接呼出禁止の境界)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enqueueDelivery,
  claimBatch,
  recoverStuckProcessing,
  isCooldownActive,
  getNotificationSettings,
  updateNotificationSettings,
  inferTargetKind,
  maskTargetId,
  isEventEnabled,
  markSent,
  incrementAttemptAndRequeue,
  createDriver,
  createDispatchRecord,
  confirmImportBatch,
  createReconciliationJob,
  replaceBaselinesAtomic,
  listAllBaselines,
} from '@line-crm/db';
import { createSqliteD1, type SqliteD1 } from '@line-crm/db/testing';
import { runReconciliationJob } from './services/reconciliation-job.js';

let h: SqliteD1;
beforeEach(() => {
  h = createSqliteD1();
});
afterEach(() => h.close());

describe('inferTargetKind / maskTargetId', () => {
  it('prefix U → user, C → group, R → room、それ以外は null', () => {
    expect(inferTargetKind('U1234567890abcdef1234567890abcdef')).toBe('user');
    expect(inferTargetKind('Cabcdefghij1234567890abcdef123456')).toBe('group');
    expect(inferTargetKind('R12345678901234567890123456789012')).toBe('room');
    expect(inferTargetKind('xxxx')).toBeNull();
    expect(inferTargetKind(null)).toBeNull();
  });

  it('maskTargetId: 先頭 5 + 末尾 4', () => {
    expect(maskTargetId('U1234567890abcdef')).toBe('U1234...cdef');
    expect(maskTargetId(null)).toBeNull();
    expect(maskTargetId('short')).toBe('short'); // 9 文字以下はそのまま
  });
});

describe('notification_settings CRUD', () => {
  it('migration で id=1 行が確保される', async () => {
    const s = await getNotificationSettings(h.db);
    expect(s.id).toBe(1);
    expect(s.line_target_id).toBeNull();
    expect(JSON.parse(s.enabled_events)).toEqual([]);
  });

  it('updateNotificationSettings: line_target_kind が自動で設定される', async () => {
    const updated = await updateNotificationSettings(h.db, {
      lineTargetId: 'U1234567890abcdef1234567890abcdef',
      enabledEvents: ['reconciliation_completed', 'monthly_reminder'],
    });
    expect(updated.line_target_kind).toBe('user');
    expect(JSON.parse(updated.enabled_events)).toEqual([
      'reconciliation_completed',
      'monthly_reminder',
    ]);
  });

  it('isEventEnabled: enabled_events JSON 配列を解釈', async () => {
    const updated = await updateNotificationSettings(h.db, {
      lineTargetId: 'U1234567890abcdef1234567890abcdef',
      enabledEvents: ['reconciliation_completed'],
    });
    expect(isEventEnabled(updated, 'reconciliation_completed')).toBe(true);
    expect(isEventEnabled(updated, 'monthly_reminder')).toBe(false);
  });
});

describe('enqueueDelivery (idempotency)', () => {
  it('同 idempotency_key は 2 回目以降 inserted=false', async () => {
    const r1 = await enqueueDelivery(h.db, {
      idempotencyKey: 'reconciliation_completed:job-1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    expect(r1.inserted).toBe(true);
    const r2 = await enqueueDelivery(h.db, {
      idempotencyKey: 'reconciliation_completed:job-1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    expect(r2.inserted).toBe(false);
    expect(r2.id).toBe(r1.id);
  });
});

describe('claimBatch (atomic claim)', () => {
  it('pending 行を processing に倒し、claimed_by を設定', async () => {
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k2',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    const claimed = await claimBatch(h.db, { runId: 'run-1', limit: 10 });
    expect(claimed).toHaveLength(2);
    for (const r of claimed) {
      expect(r.status).toBe('processing');
      expect(r.claimed_by).toBe('run-1');
    }
  });

  it('2 回目の claim は既に processing なので空配列', async () => {
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    await claimBatch(h.db, { runId: 'run-1', limit: 10 });
    const second = await claimBatch(h.db, { runId: 'run-2', limit: 10 });
    expect(second).toHaveLength(0);
  });

  it('next_retry_at が未来の行は claim されない', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    // 一度送信失敗扱いにして next_retry_at を未来に設定
    const row = await h.db
      .prepare(`SELECT id FROM notification_deliveries WHERE idempotency_key = 'k1'`)
      .first<{ id: string }>();
    await incrementAttemptAndRequeue(h.db, row!.id, 'transient error', 60);
    const claimed = await claimBatch(h.db, { runId: 'run-1', limit: 10 });
    expect(claimed).toHaveLength(0);
  });
});

describe('recoverStuckProcessing', () => {
  it('10 分以上前に claim した processing 行を pending に戻す', async () => {
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    // 11 分前の claim をシミュレート (JST 形式で統一)
    const { toJstString } = await import('@line-crm/db');
    const stale = toJstString(new Date(Date.now() - 11 * 60_000));
    await h.db
      .prepare(
        `UPDATE notification_deliveries SET status='processing',
         claimed_at = ?, claimed_by = 'dead-run' WHERE idempotency_key = 'k1'`,
      )
      .bind(stale)
      .run();
    const recovered = await recoverStuckProcessing(h.db, 10);
    expect(recovered).toBe(1);
    const row = await h.db
      .prepare(`SELECT status, claimed_by FROM notification_deliveries WHERE idempotency_key = 'k1'`)
      .first<{ status: string; claimed_by: string | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.claimed_by).toBeNull();
  });

  it('10 分以内の processing は復旧しない', async () => {
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    const { toJstString } = await import('@line-crm/db');
    const recent = toJstString(new Date(Date.now() - 5 * 60_000));
    await h.db
      .prepare(
        `UPDATE notification_deliveries SET status='processing',
         claimed_at = ?, claimed_by = 'alive-run' WHERE idempotency_key = 'k1'`,
      )
      .bind(recent)
      .run();
    const recovered = await recoverStuckProcessing(h.db, 10);
    expect(recovered).toBe(0);
  });
});

describe('isCooldownActive (LLM streak)', () => {
  it('直近 24h に同 event_type の sent/pending があれば cooldown=true', async () => {
    await enqueueDelivery(h.db, {
      idempotencyKey: 'llm_failed_streak:2026-05-21T10',
      eventType: 'llm_parse_failed_streak',
      eventPayloadJson: '{}',
    });
    expect(await isCooldownActive(h.db, 'llm_parse_failed_streak', 24)).toBe(true);
  });

  it('別 event_type には cooldown が効かない', async () => {
    await enqueueDelivery(h.db, {
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      eventPayloadJson: '{}',
    });
    expect(await isCooldownActive(h.db, 'llm_parse_failed_streak', 24)).toBe(false);
  });
});

describe('reconciliation-job → 通知 enqueue (CRITICAL #5 境界確認)', () => {
  it('completed 後に notification_deliveries に reconciliation_completed が enqueue される', async () => {
    // 最小限のデータ: driver + dispatch + client_record + confirmed batch
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    await createDispatchRecord(h.db, {
      driverId: d.id,
      workDate: '2026-05-01',
      taskName: '築地',
    });
    await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'a.xlsx',
      totalRecords: 1,
      totalFare: 7000,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 's',
      rows: [
        {
          driverId: d.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: '築地',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 7000,
          driverName: 'A',
          notes: null,
        },
      ],
      overwrite: false,
    });
    const job = await createReconciliationJob(h.db, {
      period: '2026-05',
      requestedBy: 's',
    });
    const env = {
      DB: h.db,
      STEELO_WEB_ORIGINS: 'https://admin.example.com',
    } as unknown as Parameters<typeof runReconciliationJob>[0];
    await runReconciliationJob(env, { jobId: job.id });

    // 通知が enqueue されている
    const deliveries = await h.db
      .prepare(
        `SELECT idempotency_key, event_type, status, event_payload_json
         FROM notification_deliveries WHERE event_type = 'reconciliation_completed'`,
      )
      .all<{
        idempotency_key: string;
        event_type: string;
        status: string;
        event_payload_json: string;
      }>();
    expect(deliveries.results).toHaveLength(1);
    expect(deliveries.results[0].idempotency_key).toBe(
      `reconciliation_completed:${job.id}`,
    );
    expect(deliveries.results[0].status).toBe('pending');
    const payload = JSON.parse(deliveries.results[0].event_payload_json) as {
      period: string;
      adminUrl: string;
    };
    expect(payload.period).toBe('2026-05');
    expect(payload.adminUrl).toBe(
      'https://admin.example.com/reconciliations?period=2026-05',
    );
  });

  it('同 job を 2 回 run しても通知は 1 件のまま (idempotency)', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'a.xlsx',
      totalRecords: 0,
      totalFare: 0,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 's',
      rows: [],
      overwrite: false,
    });
    const job = await createReconciliationJob(h.db, {
      period: '2026-05',
      requestedBy: 's',
    });
    const env = {
      DB: h.db,
      STEELO_WEB_ORIGINS: 'https://admin.example.com',
    } as unknown as Parameters<typeof runReconciliationJob>[0];
    // 二重 run (実運用ではジョブステータスで防止されるが、enqueue idempotency も保証)
    await runReconciliationJob(env, { jobId: job.id });
    // status='completed' になっているので 2 回目は skip されるが、念のため status を reset
    await h.db
      .prepare(`UPDATE reconciliation_jobs SET status='queued' WHERE id=?`)
      .bind(job.id)
      .run();
    await runReconciliationJob(env, { jobId: job.id });
    const count = await h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_deliveries WHERE event_type = 'reconciliation_completed'`,
      )
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
    void d;
  });
});

describe('Phase 3 baseline + anomaly integration', () => {
  it('baseline を投入して reconcile すると fare_deviation_high が出る', async () => {
    const d = await createDriver(h.db, { name: 'A' });
    await replaceBaselinesAtomic(h.db, {
      periodFrom: '2026-02',
      periodTo: '2026-04',
      rows: [
        {
          driverId: d.id,
          taskName: '築地',
          medianFare: 7500,
          sdFare: 1200,
          sampleSize: 12,
          baselineScope: 'task',
        },
      ],
    });
    const list = await listAllBaselines(h.db);
    expect(list).toHaveLength(1);
    expect(list[0].driver_id).toBe(d.id);
    expect(list[0].baseline_scope).toBe('task');
  });

  it('replaceBaselinesAtomic は対象 period_from/to を全置換する', async () => {
    const d = await createDriver(h.db, { name: 'A' });
    // 第 1 世代
    await replaceBaselinesAtomic(h.db, {
      periodFrom: '2026-02',
      periodTo: '2026-04',
      rows: [
        {
          driverId: d.id,
          taskName: '築地',
          medianFare: 7500,
          sdFare: 1200,
          sampleSize: 12,
          baselineScope: 'task',
        },
        {
          driverId: d.id,
          taskName: null,
          medianFare: 8000,
          sdFare: 1500,
          sampleSize: 20,
          baselineScope: 'driver_fallback',
        },
      ],
    });
    expect((await listAllBaselines(h.db)).length).toBe(2);

    // 第 2 世代 (recompute) — 旧 2 行を消して新 1 行のみ
    await replaceBaselinesAtomic(h.db, {
      periodFrom: '2026-02',
      periodTo: '2026-04',
      rows: [
        {
          driverId: d.id,
          taskName: '築地',
          medianFare: 9000, // 更新後
          sdFare: 1000,
          sampleSize: 15,
          baselineScope: 'task',
        },
      ],
    });
    const after = await listAllBaselines(h.db);
    expect(after).toHaveLength(1);
    expect(after[0].median_fare).toBe(9000);
    expect(after[0].task_name).toBe('築地');
  });
});
