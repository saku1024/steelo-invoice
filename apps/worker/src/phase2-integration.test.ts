// STEELO Phase 2 統合テスト: LLM 解析 + 自動照合の主要シナリオ
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createDriver,
  confirmImportBatch,
  insertLineMessageIgnoreDup,
  upsertLLMParseResult,
  getLLMParseResultByMessage,
  getLLMStats,
  listUnparsedLineMessageIds,
  createReconciliationJob,
  tryMarkReconciliationJobRunning,
  ActiveReconciliationJobExistsError,
  recoverStuckReconciliationJobs,
  insertReconciliations,
  listReconciliations,
  archivePriorReconciliations,
  commitReconciliationsAtomic,
  manualMatchReconciliation,
  ManualMatchValidationError,
  getDispatchesForPeriod,
  getClientRecordsForReconcilePeriod,
  createDispatchRecord,
} from '@line-crm/db';
import { createSqliteD1, type SqliteD1 } from '@line-crm/db/testing';
import { handleLLMParseJob } from './services/llm-parser.js';

let h: SqliteD1;
beforeEach(() => {
  h = createSqliteD1();
});
afterEach(() => h.close());

function mockAnthropic(response: { isDispatch: boolean; records: unknown[]; confidence?: string }) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          { type: 'text', text: JSON.stringify({ ...response, confidence: response.confidence ?? 'high' }) },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      })),
    },
  } as unknown as Anthropic;
}

describe('Integration: LLM Parse Result CRUD', () => {
  it('upsert で既存があれば attempt_count を増加', async () => {
    // line_messages を先に作る必要がある（FK）
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'mid-1',
      messageType: 'text',
      messageText: 'テスト',
    });
    const first = await upsertLLMParseResult(h.db, {
      lineMessageId: ins.id,
      modelName: 'claude-3-haiku-20240307',
      promptVersion: 1,
      inputJson: '{}',
      outputJson: '{"isDispatch":false}',
      status: 'success',
      errorMessage: null,
      tokenInput: 100,
      tokenOutput: 50,
      costUsd: 0.0001,
    });
    expect(first.attempt_count).toBe(1);

    const second = await upsertLLMParseResult(h.db, {
      lineMessageId: ins.id,
      modelName: 'claude-3-haiku-20240307',
      promptVersion: 1,
      inputJson: '{}',
      outputJson: '{"isDispatch":true}',
      status: 'success',
      errorMessage: null,
      tokenInput: 200,
      tokenOutput: 100,
      costUsd: 0.0002,
    });
    expect(second.attempt_count).toBe(2);
    expect(second.id).toBe(first.id);
    expect(second.token_input).toBe(200);

    const fetched = await getLLMParseResultByMessage(h.db, ins.id);
    expect(fetched!.attempt_count).toBe(2);
  });

  it('listUnparsedLineMessageIds: is_parsed=0 かつ text かつ ≥10 文字を返す', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    // 解析対象: text + 長文
    const m1 = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm1',
      messageType: 'text',
      messageText: '配車のお知らせです。明日のスケジュールです。',
    });
    // スキップ対象: image
    await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm2',
      messageType: 'image',
    });
    // スキップ対象: 短文
    await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm3',
      messageType: 'text',
      messageText: 'OK',
    });
    const ids = await listUnparsedLineMessageIds(h.db, 50);
    expect(ids).toEqual([m1.id]);
  });

  it('getLLMStats が success/failed の集計を返す', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const m1 = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm1',
      messageType: 'text',
      messageText: 'hello world test message',
    });
    const m2 = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm2',
      messageType: 'text',
      messageText: 'another message text content',
    });
    await upsertLLMParseResult(h.db, {
      lineMessageId: m1.id,
      modelName: 'm',
      promptVersion: 1,
      inputJson: '{}',
      outputJson: '{}',
      status: 'success',
      errorMessage: null,
      tokenInput: 100,
      tokenOutput: 50,
      costUsd: 0.001,
    });
    await upsertLLMParseResult(h.db, {
      lineMessageId: m2.id,
      modelName: 'm',
      promptVersion: 1,
      inputJson: '{}',
      outputJson: null,
      status: 'failed',
      errorMessage: 'timeout',
      tokenInput: null,
      tokenOutput: null,
      costUsd: null,
    });
    const s = await getLLMStats(h.db);
    expect(s.total).toBe(2);
    expect(s.success).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.token_input_sum).toBe(100);
    expect(s.cost_usd_sum).toBeCloseTo(0.001, 5);
  });
});

describe('Integration: LLM Parser end-to-end (mocked Anthropic)', () => {
  it('isDispatch=true: dispatch_records が作成され is_parsed=1, is_dispatch=1', async () => {
    const d = await createDriver(h.db, { name: '田中太郎', lineGroupId: 'G_tanaka' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_tanaka',
      driverId: d.id,
      messageId: 'mid-1',
      messageType: 'text',
      messageText: '田中太郎さん 明日の案件 ①築地チャーター 06:00 東京 集荷',
      receivedAt: '2026-05-19T22:00:00+09:00',
    });
    const client = mockAnthropic({
      isDispatch: true,
      records: [
        {
          driverName: '田中太郎',
          workDate: '2026-05-20',
          taskNumber: 1,
          taskName: '築地チャーター',
          startTime: '06:00',
        },
      ],
    });
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    const r = await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    expect(r.status).toBe('success');
    expect(r.isDispatch).toBe(true);
    expect(r.dispatchRecordIds).toHaveLength(1);

    // line_messages が更新されている
    const lm = await h.db
      .prepare(`SELECT is_parsed, is_dispatch FROM line_messages WHERE id = ?`)
      .bind(ins.id)
      .first<{ is_parsed: number; is_dispatch: number }>();
    expect(lm!.is_parsed).toBe(1);
    expect(lm!.is_dispatch).toBe(1);

    // dispatch_records も作成されている
    const dr = await h.db
      .prepare(`SELECT * FROM dispatch_records WHERE id = ?`)
      .bind(r.dispatchRecordIds[0])
      .first<{ task_name: string; work_date: string; confidence: string; status: string }>();
    expect(dr!.task_name).toBe('築地チャーター');
    expect(dr!.work_date).toBe('2026-05-20');
    expect(dr!.confidence).toBe('high');
    expect(dr!.status).toBe('auto');
  });

  it('isDispatch=false: dispatch_records は作成されず is_dispatch=0', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-greet',
      messageType: 'text',
      messageText: 'お疲れさまでした。今日もありがとうございました。',
    });
    const client = mockAnthropic({ isDispatch: false, records: [] });
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    const r = await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    expect(r.status).toBe('success');
    expect(r.isDispatch).toBe(false);
    expect(r.dispatchRecordIds).toHaveLength(0);

    const count = await h.db
      .prepare(`SELECT COUNT(*) AS n FROM dispatch_records WHERE driver_id = ?`)
      .bind(d.id)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('短文メッセージはスキップ（LLM 呼出なし）', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-short',
      messageType: 'text',
      messageText: 'OK',
    });
    const client = mockAnthropic({ isDispatch: true, records: [{ taskName: 'X' }] });
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    const r = await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    expect(r.status).toBe('skipped');
    // create がモック呼出されていない（短文スキップ）
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('confidence=low の場合 dispatch_records.status="needs_review"', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-low',
      messageType: 'text',
      messageText: '何かそれっぽいメッセージ 配車みたいなもの',
    });
    const client = mockAnthropic({
      isDispatch: true,
      confidence: 'low',
      records: [{ taskName: 'なんか', workDate: '2026-05-20' }],
    });
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    const r = await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    expect(r.status).toBe('success');
    const dr = await h.db
      .prepare(`SELECT status, confidence FROM dispatch_records WHERE id = ?`)
      .bind(r.dispatchRecordIds[0])
      .first<{ status: string; confidence: string }>();
    expect(dr!.status).toBe('needs_review');
    expect(dr!.confidence).toBe('low');
  });
});

describe('Integration: Reconciliation Jobs', () => {
  it('UNIQUE 違反で同 period 二重投入を拒否', async () => {
    await createReconciliationJob(h.db, {
      period: '2026-05',
      requestedBy: 'staff-1',
    });
    await expect(
      createReconciliationJob(h.db, {
        period: '2026-05',
        requestedBy: 'staff-2',
      })
    ).rejects.toBeInstanceOf(ActiveReconciliationJobExistsError);
  });

  it('tryMarkRunning は二度目以降 false', async () => {
    const job = await createReconciliationJob(h.db, {
      period: '2026-06',
      requestedBy: 'staff-1',
    });
    expect(await tryMarkReconciliationJobRunning(h.db, job.id)).toBe(true);
    expect(await tryMarkReconciliationJobRunning(h.db, job.id)).toBe(false);
  });

  it('recoverStuckReconciliationJobs で長時間 running を failed に', async () => {
    const job = await createReconciliationJob(h.db, {
      period: '2026-07',
      requestedBy: 'staff-1',
    });
    const ago = new Date(Date.now() - 60 * 60_000).toISOString();
    await h.db
      .prepare(`UPDATE reconciliation_jobs SET status='running', started_at=? WHERE id=?`)
      .bind(ago, job.id)
      .run();
    const recovered = await recoverStuckReconciliationJobs(h.db, 30);
    expect(recovered).toBe(1);
    // 同 period を再投入できる
    const job2 = await createReconciliationJob(h.db, {
      period: '2026-07',
      requestedBy: 'staff-2',
    });
    expect(job2.id).not.toBe(job.id);
  });
});

describe('Integration: Reconciliation INSERT + archive', () => {
  it('insertReconciliations 50 行刻みで一括 INSERT', async () => {
    const job = await createReconciliationJob(h.db, {
      period: '2026-05',
      requestedBy: 's',
    });
    const rows = Array.from({ length: 75 }, (_, i) => ({
      period: '2026-05',
      reconciliationJobId: job.id,
      dispatchId: null,
      clientRecordId: null,
      matchStatus: 'dispatch_only' as const,
      matchMethod: 'none' as const,
      matchScore: 0,
      warningsJson: null,
    }));
    const n = await insertReconciliations(h.db, rows);
    expect(n).toBe(75);
    const r = await listReconciliations(h.db, { period: '2026-05' });
    expect(r.total).toBe(75);
  });

  it('archivePriorReconciliations: reviewed=1 は archived_reviewed に', async () => {
    const job = await createReconciliationJob(h.db, {
      period: '2026-05',
      requestedBy: 's',
    });
    await insertReconciliations(h.db, [
      {
        period: '2026-05',
        reconciliationJobId: job.id,
        dispatchId: null,
        clientRecordId: null,
        matchStatus: 'dispatch_only',
        matchMethod: 'none',
        matchScore: 0,
        warningsJson: null,
      },
      {
        period: '2026-05',
        reconciliationJobId: job.id,
        dispatchId: null,
        clientRecordId: null,
        matchStatus: 'matched',
        matchMethod: 'strong',
        matchScore: 1,
        warningsJson: null,
      },
    ]);
    // 1 行を reviewed=1 に
    const list = await listReconciliations(h.db, { period: '2026-05' });
    await h.db
      .prepare(`UPDATE reconciliations SET reviewed = 1 WHERE id = ?`)
      .bind(list.items[0].id)
      .run();
    const { archived, archivedReviewed } = await archivePriorReconciliations(h.db, '2026-05');
    expect(archived).toBe(1);
    expect(archivedReviewed).toBe(1);
    const activeRows = await listReconciliations(h.db, { period: '2026-05', status: 'active' });
    expect(activeRows.total).toBe(0);
    const reviewedRows = await listReconciliations(h.db, {
      period: '2026-05',
      status: 'archived_reviewed',
    });
    expect(reviewedRows.total).toBe(1);
  });
});

describe('Integration: get*ForReconcilePeriod ヘルパ', () => {
  it('dispatch_records は work_date の period 部分一致で取得', async () => {
    const d = await createDriver(h.db, { name: 'A' });
    await createDispatchRecord(h.db, {
      driverId: d.id,
      workDate: '2026-05-15',
      taskName: 'A',
    });
    await createDispatchRecord(h.db, {
      driverId: d.id,
      workDate: '2026-06-01',
      taskName: 'B',
    });
    const may = await getDispatchesForPeriod(h.db, '2026-05');
    expect(may).toHaveLength(1);
    expect(may[0].task_name).toBe('A');
  });

  it('client_records は confirmed バッチのみ', async () => {
    const d = await createDriver(h.db, { name: 'A' });
    // confirmed batch
    await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'a.xlsx',
      totalRecords: 1,
      totalFare: 1000,
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
          workDay: 5,
          dayOfWeek: null,
          taskName: 'A',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 1000,
          driverName: 'A',
          notes: null,
        },
      ],
      overwrite: false,
    });
    const rows = await getClientRecordsForReconcilePeriod(h.db, '2026-05');
    expect(rows).toHaveLength(1);
    expect(rows[0].fare).toBe(1000);
  });
});

describe('Integration: Codex Phase 2 review CRITICAL fixes', () => {
  it('CRITICAL #2: 再 parse で auto/needs_review の dispatch_records が重複しない', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-redo',
      messageType: 'text',
      messageText: '田中さん 明日 ①築地チャーター 06:00 東京 集荷',
      receivedAt: '2026-05-19T22:00:00+09:00',
    });
    const client = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                isDispatch: true,
                confidence: 'high',
                records: [
                  { taskName: '築地チャーター', workDate: '2026-05-20', startTime: '06:00' },
                ],
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
      },
    } as never;
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    // 3 回呼んでも dispatch_records は 1 件のまま
    const cnt = await h.db
      .prepare(`SELECT COUNT(*) AS n FROM dispatch_records WHERE raw_message_id = ?`)
      .bind(ins.id)
      .first<{ n: number }>();
    expect(cnt!.n).toBe(1);
  });

  it('CRITICAL #2: confirmed 状態の dispatch_records は再 parse で消えない', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-conf',
      messageType: 'text',
      messageText: '配車のお知らせ 明日 業務A 06:00 東京 集荷',
    });
    // 既存 confirmed dispatch
    await createDispatchRecord(h.db, {
      driverId: d.id,
      workDate: '2026-05-20',
      taskName: '業務A',
      rawMessageId: ins.id,
      status: 'confirmed',
    });
    const client = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                isDispatch: true,
                confidence: 'high',
                records: [{ taskName: '業務B', workDate: '2026-05-20', startTime: '06:00' }],
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
      },
    } as never;
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    // confirmed 1 + new auto 1
    const all = await h.db
      .prepare(`SELECT task_name, status FROM dispatch_records WHERE raw_message_id = ? ORDER BY status`)
      .bind(ins.id)
      .all<{ task_name: string; status: string }>();
    expect(all.results).toHaveLength(2);
    expect(all.results.map((r) => r.status).sort()).toEqual(['auto', 'confirmed']);
    expect(all.results.find((r) => r.status === 'confirmed')!.task_name).toBe('業務A');
  });

  it('CRITICAL #3: commitReconciliationsAtomic で archive + insert が一貫', async () => {
    const job1 = await createReconciliationJob(h.db, { period: '2026-05', requestedBy: 's' });
    await commitReconciliationsAtomic(h.db, '2026-05', [
      {
        period: '2026-05',
        reconciliationJobId: job1.id,
        dispatchId: null,
        clientRecordId: null,
        matchStatus: 'dispatch_only',
        matchMethod: 'none',
        matchScore: 0,
        warningsJson: null,
      },
    ]);
    const r1 = await listReconciliations(h.db, { period: '2026-05' });
    expect(r1.total).toBe(1);

    // 第 2 回: 旧 active が archived に倒れ、新 active が入る
    await h.db
      .prepare(`UPDATE reconciliation_jobs SET status='completed' WHERE id=?`)
      .bind(job1.id)
      .run();
    const job2 = await createReconciliationJob(h.db, { period: '2026-05', requestedBy: 's' });
    await commitReconciliationsAtomic(h.db, '2026-05', [
      {
        period: '2026-05',
        reconciliationJobId: job2.id,
        dispatchId: null,
        clientRecordId: null,
        matchStatus: 'client_only',
        matchMethod: 'none',
        matchScore: 0,
        warningsJson: null,
      },
      {
        period: '2026-05',
        reconciliationJobId: job2.id,
        dispatchId: null,
        clientRecordId: null,
        matchStatus: 'matched',
        matchMethod: 'strong',
        matchScore: 1,
        warningsJson: null,
      },
    ]);
    const active = await listReconciliations(h.db, { period: '2026-05', status: 'active' });
    expect(active.total).toBe(2);
    const archived = await listReconciliations(h.db, { period: '2026-05', status: 'archived' });
    expect(archived.total).toBe(1);
  });
});

describe('Integration: Codex Phase 2 review HIGH fixes', () => {
  it('HIGH #6: UPSERT が並行 invocation で UNIQUE 違反にならない', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-upsert',
      messageType: 'text',
      messageText: 'hello world test',
    });
    // 同時に複数 UPSERT
    await Promise.all(
      Array.from({ length: 5 }, () =>
        upsertLLMParseResult(h.db, {
          lineMessageId: ins.id,
          modelName: 'm',
          promptVersion: 1,
          inputJson: '{}',
          outputJson: null,
          status: 'success',
          errorMessage: null,
          tokenInput: 10,
          tokenOutput: 5,
          costUsd: 0.0001,
        })
      )
    );
    // 1 行のみ存在し、attempt_count >= 5
    const cnt = await h.db
      .prepare(`SELECT COUNT(*) AS n, MAX(attempt_count) AS max_a FROM llm_parse_results WHERE line_message_id = ?`)
      .bind(ins.id)
      .first<{ n: number; max_a: number }>();
    expect(cnt!.n).toBe(1);
    expect(cnt!.max_a).toBeGreaterThanOrEqual(5);
  });

  it('HIGH #7: LLM が isDispatch=true でも driver 未解決時は is_parsed=0 のまま残す', async () => {
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_unknown', // ドライバーマスタに無いグループ
      messageId: 'm-no-driver',
      messageType: 'text',
      messageText: '配車のお知らせ 明日 業務A 06:00 東京 集荷',
    });
    const client = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                isDispatch: true,
                confidence: 'high',
                records: [{ taskName: '業務A', workDate: '2026-05-20', startTime: '06:00' }],
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
      },
    } as never;
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    const r = await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    expect(r.dispatchRecordIds).toHaveLength(0);
    const lm = await h.db
      .prepare(`SELECT is_parsed, is_dispatch FROM line_messages WHERE id=?`)
      .bind(ins.id)
      .first<{ is_parsed: number; is_dispatch: number }>();
    // is_dispatch=1 で記録するが is_parsed=0 のまま（driver_alias 追加後に再 parse 可能）
    expect(lm!.is_parsed).toBe(0);
    expect(lm!.is_dispatch).toBe(1);
  });

  it('HIGH #11: 不完全 records (taskName 欠落) は confidence=high でも needs_review に倒す', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const ins = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      messageId: 'm-incomp',
      messageType: 'text',
      messageText: '配車のお知らせ 明日 06:00 東京 集荷',
    });
    const client = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                isDispatch: true,
                confidence: 'high', // LLM は high と言うが…
                records: [{ taskName: null, workDate: '2026-05-20', startTime: '06:00' }],
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
      },
    } as never;
    const env = { DB: h.db } as { DB: D1Database } & Record<string, unknown>;
    const r = await handleLLMParseJob(env as never, { lineMessageId: ins.id }, { client });
    const dr = await h.db
      .prepare(`SELECT status, confidence FROM dispatch_records WHERE id=?`)
      .bind(r.dispatchRecordIds[0])
      .first<{ status: string; confidence: string }>();
    // taskName 欠落 → needs_review + confidence=low に強制
    expect(dr!.status).toBe('needs_review');
    expect(dr!.confidence).toBe('low');
  });

  it('HIGH #9: manual match で別 period の dispatch を弾く', async () => {
    const job = await createReconciliationJob(h.db, { period: '2026-05', requestedBy: 's' });
    await commitReconciliationsAtomic(h.db, '2026-05', [
      {
        period: '2026-05',
        reconciliationJobId: job.id,
        dispatchId: null,
        clientRecordId: null,
        matchStatus: 'client_only',
        matchMethod: 'none',
        matchScore: 0,
        warningsJson: null,
      },
    ]);
    const recon = (await listReconciliations(h.db, { period: '2026-05' })).items[0];
    const d = await createDriver(h.db, { name: 'A' });
    const otherDispatch = await createDispatchRecord(h.db, {
      driverId: d.id,
      workDate: '2026-06-15', // 別 period
      taskName: 'X',
    });
    await expect(
      manualMatchReconciliation(h.db, recon.id, {
        dispatchId: otherDispatch.id,
        reviewedBy: 's',
      })
    ).rejects.toBeInstanceOf(ManualMatchValidationError);
  });
});
