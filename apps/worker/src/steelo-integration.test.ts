// STEELO Phase 1 Task 14.1: Worker 側統合テスト
//
// 複数モジュールにまたがるシナリオを in-memory SQLite で再現する:
//   1. LINE グループメッセージの再送冪等性
//   2. Excel preview → confirm → 上書き → 409
//   3. 個別支払明細生成 → スナップショット保存 → 再 DL
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  confirmImportBatch,
  ConfirmedBatchAlreadyExistsError,
  createDriver,
  upsertDriverDeduction,
  listClientRecordsByDriverPeriod,
  getConfirmedBatchByPeriod,
  upsertDriverPaymentSummary,
  insertSummaryLines,
  listSummaryLines,
  getDriverPaymentSummaryById,
  createPaymentJob,
  tryMarkPaymentJobRunning,
  ActiveJobAlreadyExistsError,
  recoverStuckPaymentJobs,
  insertLineMessageIgnoreDup,
} from '@line-crm/db'
// test-helpers は @line-crm/db の testing サブパスから import する
// （barrel から re-export すると node:fs / better-sqlite3 が Worker バンドルに混入するため）
import { createSqliteD1, type SqliteD1 } from '@line-crm/db/testing'
import { calculatePayment } from './services/payment-calculator.js'
import { buildDriverExcel } from './services/excel-export.js'
import { handleGroupMessage } from './services/group-message-handler.js'
import type { WebhookEvent } from '@line-crm/line-sdk'

function makeApp() {
  const app = new Hono()
  return app
}
void makeApp

let h: SqliteD1
beforeEach(() => {
  h = createSqliteD1()
})
afterEach(() => {
  h.close()
})

function groupTextEvent(opts: { groupId: string; messageId: string; text?: string }): WebhookEvent {
  return {
    type: 'message',
    source: { type: 'group', groupId: opts.groupId, userId: 'U_x' },
    timestamp: Date.parse('2026-05-20T01:00:00Z'),
    replyToken: 'rt',
    message: { id: opts.messageId, type: 'text', text: opts.text ?? 'hello' },
  } as unknown as WebhookEvent
}

describe('Integration: LINE group webhook idempotency', () => {
  it('同 message_id で再送された場合、line_messages は重複しない', async () => {
    const d = await createDriver(h.db, { name: '田中太郎', lineGroupId: 'G_a' })
    await handleGroupMessage(h.db, groupTextEvent({ groupId: 'G_a', messageId: 'mid-1' }))
    await handleGroupMessage(h.db, groupTextEvent({ groupId: 'G_a', messageId: 'mid-1' }))
    await handleGroupMessage(h.db, groupTextEvent({ groupId: 'G_a', messageId: 'mid-2' }))

    const cnt = await h.db
      .prepare(`SELECT COUNT(*) AS n FROM line_messages WHERE group_id = ?`)
      .bind('G_a')
      .first<{ n: number }>()
    expect(cnt!.n).toBe(2) // mid-1 重複は黙過

    const linked = await h.db
      .prepare(`SELECT COUNT(*) AS n FROM line_messages WHERE driver_id = ?`)
      .bind(d.id)
      .first<{ n: number }>()
    expect(linked!.n).toBe(2)
  })

  it('未登録グループは driver_id=NULL で保存される', async () => {
    await handleGroupMessage(h.db, groupTextEvent({ groupId: 'G_unknown', messageId: 'mid-3' }))
    const row = await h.db
      .prepare(`SELECT driver_id FROM line_messages WHERE message_id = ?`)
      .bind('mid-3')
      .first<{ driver_id: string | null }>()
    expect(row!.driver_id).toBeNull()
  })
})

describe('Integration: Excel preview → confirm → overwrite', () => {
  it('preview→confirm 後、二度目の confirm は 409 を投げる', async () => {
    const a = await createDriver(h.db, { name: 'A' })
    const baseInput = {
      period: '2026-05',
      fileName: 'BOND_2026-05.xlsx',
      totalRecords: 1,
      totalFare: 7680,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: 'T',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 7680,
          driverName: 'A',
          notes: null,
        },
      ],
      overwrite: false,
    }
    await confirmImportBatch(h.db, baseInput)
    await expect(confirmImportBatch(h.db, baseInput)).rejects.toBeInstanceOf(
      ConfirmedBatchAlreadyExistsError
    )
  })

  it('overwrite=true で旧バッチが archived 化され、新 confirmed に切り替わる', async () => {
    const a = await createDriver(h.db, { name: 'A' })
    const input = (overwrite: boolean) => ({
      period: '2026-05',
      fileName: 'BOND.xlsx',
      totalRecords: 1,
      totalFare: overwrite ? 9999 : 7680,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: null,
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: overwrite ? 9999 : 7680,
          driverName: 'A',
          notes: null,
        },
      ],
      overwrite,
    })

    const first = await confirmImportBatch(h.db, input(false))
    const second = await confirmImportBatch(h.db, input(true))
    expect(second.archivedBatchId).toBe(first.batchId)

    // confirmed バッチは 1 件のみ
    const confirmed = await getConfirmedBatchByPeriod(h.db, '2026-05')
    expect(confirmed!.id).toBe(second.batchId)
    expect(confirmed!.total_fare).toBe(9999)

    // archived の client_records は driver-period queries には返らない
    const rows = await listClientRecordsByDriverPeriod(h.db, a.id, '2026-05')
    expect(rows.length).toBe(1)
    expect(rows[0].fare).toBe(9999) // 新バッチの値
  })
})

describe('Integration: 個別支払明細生成 → スナップショット → 再生成', () => {
  it('生成 → スナップショット保存 → 再生成で UPSERT される', async () => {
    const a = await createDriver(h.db, { name: 'A', hasInvoice: true })
    await upsertDriverDeduction(h.db, {
      driverId: a.id,
      period: '2026-05',
      vehicleCost: 1000,
      processingFee: 500,
      prepayment: 0,
    })
    await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'b.xlsx',
      totalRecords: 1,
      totalFare: 7680,
      totalAdvance: 1040,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: '築地',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 1040,
          fare: 7680,
          driverName: 'A',
          notes: null,
        },
      ],
      overwrite: false,
    })

    // 計算
    const records = await listClientRecordsByDriverPeriod(h.db, a.id, '2026-05')
    const payment = calculatePayment({
      driver: { hasInvoice: true },
      rates: { commissionRate: 0.075, taxRate: 0.1 },
      deductions: { vehicleCost: 1000, processingFee: 500, prepayment: 0 },
      records: records.map((r) => ({ fare: r.fare, advancePayment: r.advance_payment })),
    })
    // インボイスあり: 7680 → 7104 → 7814、立替 1040、控除 1500 → 最終 7354
    expect(payment.totalFareWithTax).toBe(7814)
    expect(payment.totalAdvance).toBe(1040)
    expect(payment.finalAmount).toBe(7814 + 1040 - 1000 - 500)

    const xlsx = buildDriverExcel({
      driver: { name: 'A', hasInvoice: true },
      period: '2026-05',
      records: records.map((r) => ({
        workDay: r.work_day,
        dayOfWeek: r.day_of_week,
        taskName: r.task_name,
        pickupLocation: r.pickup_location,
        deliveryLocation: r.delivery_location,
        startTime: r.start_time,
        endTime: r.end_time,
        distanceKm: r.distance_km,
        advancePayment: r.advance_payment,
        fare: r.fare,
        notes: r.notes,
      })),
      result: payment,
    })
    expect(xlsx.byteLength).toBeGreaterThan(0)
  })
})

describe('Integration: スナップショットからの Excel 再構築 (HIGH #7)', () => {
  it('payment_summary_lines があれば現在マスタを介さず Excel を再生成できる', async () => {
    const a = await createDriver(h.db, { name: 'A-original', hasInvoice: true })
    // confirmed batch を作っておく（summary の FK 用）
    await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'b.xlsx',
      totalRecords: 0,
      totalFare: 0,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [],
      overwrite: false,
    })
    const batch = (await getConfirmedBatchByPeriod(h.db, '2026-05'))!
    // スナップショット summary を直接書く（生成時の名前は 'A-snapshot'）
    const summary = await upsertDriverPaymentSummary(h.db, {
      driverId: a.id,
      period: '2026-05',
      importBatchId: batch.id,
      paymentJobId: null,
      driverNameSnapshot: 'A-snapshot',
      hasInvoiceSnapshot: true,
      commissionRateSnapshot: 0.075,
      taxRateSnapshot: 0.1,
      totalFareBeforeTax: 7104,
      totalFareWithTax: 7814,
      totalAdvance: 1040,
      vehicleCost: 0,
      processingFee: 0,
      prepayment: 0,
      finalAmount: 8854,
      r2XlsxKey: null,
    })
    await insertSummaryLines(h.db, [
      {
        summaryId: summary.id,
        clientRecordId: null,
        workDay: 1,
        taskName: '築地',
        fare: 7680,
        fareAfterCommission: 7104,
        fareWithTax: 7814,
        advancePayment: 1040,
        excludedFromCalc: false,
      },
    ])
    // ドライバー名を変更してもスナップショットは古い値のはず
    const updatedSummary = (await getDriverPaymentSummaryById(h.db, summary.id))!
    expect(updatedSummary.driver_name_snapshot).toBe('A-snapshot')

    const lines = await listSummaryLines(h.db, summary.id)
    expect(lines.length).toBe(1)
    expect(lines[0].fare_with_tax).toBe(7814)
  })
})

describe('Integration: payment_jobs 並行排他とリカバリ (HIGH #8/#9)', () => {
  it('active_period_key UNIQUE が同 period の二重投入を弾く', async () => {
    await createPaymentJob(h.db, {
      period: '2026-05',
      requestedBy: 'staff-1',
      totalDrivers: 5,
    })
    await expect(
      createPaymentJob(h.db, {
        period: '2026-05',
        requestedBy: 'staff-2',
        totalDrivers: 5,
      })
    ).rejects.toBeInstanceOf(ActiveJobAlreadyExistsError)
  })

  it('tryMarkPaymentJobRunning は二度目以降 false を返す', async () => {
    const job = await createPaymentJob(h.db, {
      period: '2026-06',
      requestedBy: 'staff-1',
      totalDrivers: 3,
    })
    expect(await tryMarkPaymentJobRunning(h.db, job.id)).toBe(true)
    // 既に running なので 2 回目は false
    expect(await tryMarkPaymentJobRunning(h.db, job.id)).toBe(false)
  })

  it('recoverStuckPaymentJobs は古い running を failed に倒す', async () => {
    const job = await createPaymentJob(h.db, {
      period: '2026-07',
      requestedBy: 'staff-1',
      totalDrivers: 1,
    })
    // started_at を 1 時間前に手動更新
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    await h.db
      .prepare(`UPDATE payment_jobs SET status='running', started_at=? WHERE id=?`)
      .bind(oneHourAgo, job.id)
      .run()
    const recovered = await recoverStuckPaymentJobs(h.db, 30)
    expect(recovered).toBe(1)
    const after = await h.db
      .prepare(`SELECT status, error_message FROM payment_jobs WHERE id=?`)
      .bind(job.id)
      .first<{ status: string; error_message: string }>()
    expect(after!.status).toBe('failed')
    expect(after!.error_message).toContain('recovered')
  })

  it('recoverStuckPaymentJobs 後は同 period に新しい active job を投入できる', async () => {
    const job = await createPaymentJob(h.db, {
      period: '2026-08',
      requestedBy: 'staff-1',
      totalDrivers: 1,
    })
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    await h.db
      .prepare(`UPDATE payment_jobs SET status='running', started_at=? WHERE id=?`)
      .bind(oneHourAgo, job.id)
      .run()
    await recoverStuckPaymentJobs(h.db, 30)
    // 同 period で再投入できる
    const job2 = await createPaymentJob(h.db, {
      period: '2026-08',
      requestedBy: 'staff-2',
      totalDrivers: 1,
    })
    expect(job2.id).not.toBe(job.id)
  })
})

describe('Integration: import_batches confirm の原子性 (CRITICAL #2/#3)', () => {
  it('overwrite 時に旧 confirmed は最終 batch まで保持される', async () => {
    const a = await createDriver(h.db, { name: 'A' })
    // 旧 confirmed
    const first = await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'first.xlsx',
      totalRecords: 1,
      totalFare: 1000,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: 'T1',
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
    })
    // 新 confirmed (overwrite)
    const second = await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'second.xlsx',
      totalRecords: 1,
      totalFare: 2000,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: 'T2',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 2000,
          driverName: 'A',
          notes: null,
        },
      ],
      overwrite: true,
    })
    expect(second.archivedBatchId).toBe(first.batchId)

    // 旧 batch は archived として残っている
    const oldRow = await h.db
      .prepare(`SELECT status FROM import_batches WHERE id = ?`)
      .bind(first.batchId)
      .first<{ status: string }>()
    expect(oldRow!.status).toBe('archived')

    // 旧 batch の client_records も削除されず残っている（監査に必要）
    const oldRecords = await h.db
      .prepare(`SELECT COUNT(*) AS n FROM client_records WHERE import_batch_id = ?`)
      .bind(first.batchId)
      .first<{ n: number }>()
    expect(oldRecords!.n).toBe(1)
  })

  it('audit option があると confirm と同 batch で audit_logs が書かれる', async () => {
    const a = await createDriver(h.db, { name: 'A' })
    await confirmImportBatch(h.db, {
      period: '2026-05',
      fileName: 'b.xlsx',
      totalRecords: 1,
      totalFare: 1000,
      totalAdvance: 0,
      headerVehicleCost: 0,
      headerProcessingFee: 0,
      headerPrepayment: 0,
      commissionRate: 0.075,
      taxRate: 0.1,
      templateVersion: null,
      confirmedBy: 'staff-1',
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: null,
          taskName: null,
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
      audit: {
        actorId: 'staff-1',
        actorName: 'Alice',
        ip: '203.0.113.1',
        userAgent: 'UA',
      },
    })
    const log = await h.db
      .prepare(`SELECT * FROM audit_logs WHERE action = 'import_confirm'`)
      .first<{
        actor_id: string
        actor_name: string
        resource_type: string
        ip: string | null
      }>()
    expect(log).not.toBeNull()
    expect(log!.actor_id).toBe('staff-1')
    expect(log!.actor_name).toBe('Alice')
    expect(log!.resource_type).toBe('import_batch')
    expect(log!.ip).toBe('203.0.113.1')
  })
})

describe('Integration: line_messages 冪等性 (補強)', () => {
  it('groupId / driver_id 違いでも同 message_id は 1 件のみ', async () => {
    const a = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' })
    void a
    // 同じ message_id で 3 回 INSERT 試行
    const r1 = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      messageId: 'dup-1',
      messageType: 'text',
      messageText: 'first',
    })
    const r2 = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      messageId: 'dup-1',
      messageType: 'text',
      messageText: 'second',
    })
    const r3 = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_other',
      messageId: 'dup-1',
      messageType: 'text',
      messageText: 'third',
    })
    expect(r1.inserted).toBe(true)
    expect(r2.inserted).toBe(false)
    expect(r3.inserted).toBe(false)
    // 2 回目以降の inserted=false は同じ id を返す（既存行参照）
    expect(r2.id).toBe(r1.id)
    expect(r3.id).toBe(r1.id)
    const count = (
      await h.db
        .prepare(`SELECT COUNT(*) AS n FROM line_messages`)
        .first<{ n: number }>()
    )!.n
    expect(count).toBe(1)
  })
})
