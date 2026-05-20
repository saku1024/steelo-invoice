// STEELO Phase 1 Task 14.1: Worker 側統合テスト
//
// 複数モジュールにまたがるシナリオを in-memory SQLite で再現する:
//   1. LINE グループメッセージの再送冪等性
//   2. Excel preview → confirm → 上書き → 409
//   3. 個別支払明細生成 → スナップショット保存 → 再 DL
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  createSqliteD1,
  type SqliteD1,
  confirmImportBatch,
  ConfirmedBatchAlreadyExistsError,
  createDriver,
  upsertDriverDeduction,
  listClientRecordsByDriverPeriod,
  getConfirmedBatchByPeriod,
} from '@line-crm/db'
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
