import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDriver } from './drivers.js';
import {
  listDriverDeductions,
  getDriverDeduction,
  upsertDriverDeduction,
} from './driver-deductions.js';
import { createSqliteD1, type SqliteD1 } from './test-helpers/sqlite-d1.js';

let h: SqliteD1;

beforeEach(() => {
  h = createSqliteD1();
});

afterEach(() => {
  h.close();
});

describe('upsertDriverDeduction', () => {
  it('新規 INSERT が成功し getDriverDeduction で取得できる', async () => {
    const d = await createDriver(h.db, { name: 'A' });
    const row = await upsertDriverDeduction(h.db, {
      driverId: d.id,
      period: '2026-05',
      vehicleCost: 1000,
      processingFee: 500,
      prepayment: 0,
      updatedBy: 'staff-1',
    });
    expect(row.vehicle_cost).toBe(1000);
    expect(row.processing_fee).toBe(500);
    expect(row.prepayment).toBe(0);
    expect(row.updated_by).toBe('staff-1');

    const fetched = await getDriverDeduction(h.db, d.id, '2026-05');
    expect(fetched!.id).toBe(row.id);
  });

  it('同 (driver_id, period) で2回 upsert すると UPDATE される', async () => {
    const d = await createDriver(h.db, { name: 'A' });
    const first = await upsertDriverDeduction(h.db, {
      driverId: d.id,
      period: '2026-05',
      vehicleCost: 1000,
      processingFee: 500,
      prepayment: 0,
    });
    const second = await upsertDriverDeduction(h.db, {
      driverId: d.id,
      period: '2026-05',
      vehicleCost: 2000,
      processingFee: 500,
      prepayment: 3000,
      notes: '更新',
      updatedBy: 'staff-2',
    });
    expect(second.id).toBe(first.id);
    expect(second.vehicle_cost).toBe(2000);
    expect(second.prepayment).toBe(3000);
    expect(second.notes).toBe('更新');
    expect(second.updated_by).toBe('staff-2');
    expect(
      (
        await h.db
          .prepare(`SELECT COUNT(*) AS n FROM driver_deductions`)
          .bind()
          .first<{ n: number }>()
      )!.n
    ).toBe(1);
  });

  it('listDriverDeductions は period で絞れる', async () => {
    const a = await createDriver(h.db, { name: 'A' });
    const b = await createDriver(h.db, { name: 'B' });
    await upsertDriverDeduction(h.db, {
      driverId: a.id,
      period: '2026-05',
      vehicleCost: 1,
      processingFee: 0,
      prepayment: 0,
    });
    await upsertDriverDeduction(h.db, {
      driverId: b.id,
      period: '2026-05',
      vehicleCost: 2,
      processingFee: 0,
      prepayment: 0,
    });
    await upsertDriverDeduction(h.db, {
      driverId: a.id,
      period: '2026-06',
      vehicleCost: 3,
      processingFee: 0,
      prepayment: 0,
    });
    expect((await listDriverDeductions(h.db, { period: '2026-05' })).length).toBe(2);
    expect((await listDriverDeductions(h.db, { driverId: a.id })).length).toBe(2);
    expect((await listDriverDeductions(h.db)).length).toBe(3);
  });
});
