import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  confirmImportBatch,
  getConfirmedBatchByPeriod,
  listClientRecordsByBatch,
  listClientRecordsByDriverPeriod,
  listImportBatches,
  ConfirmedBatchAlreadyExistsError,
  createImportPreview,
  getImportPreview,
  deleteExpiredImportPreviews,
} from './import-batches.js';
import { createDriver } from './drivers.js';
import { createSqliteD1, type SqliteD1 } from './test-helpers/sqlite-d1.js';

let h: SqliteD1;
beforeEach(() => {
  h = createSqliteD1();
});
afterEach(() => {
  h.close();
});

function baseInput(period: string, overwrite = false) {
  return {
    period,
    fileName: 'BOND_2026-05.xlsx',
    totalRecords: 0,
    totalFare: 100000,
    totalAdvance: 5000,
    headerVehicleCost: 0,
    headerProcessingFee: 1000,
    headerPrepayment: 0,
    commissionRate: 0.075,
    taxRate: 0.1,
    templateVersion: null,
    confirmedBy: 'staff-1',
    rows: [] as never[],
    overwrite,
  };
}

describe('confirmImportBatch', () => {
  it('新規 period の確定が成功し client_records を生成する', async () => {
    const a = await createDriver(h.db, { name: 'A' });
    const result = await confirmImportBatch(h.db, {
      ...baseInput('2026-05'),
      totalRecords: 2,
      rows: [
        {
          driverId: a.id,
          workDay: 1,
          dayOfWeek: '木',
          taskName: '築地',
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
        {
          driverId: null,
          workDay: 2,
          dayOfWeek: '金',
          taskName: '定期便',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 1040,
          fare: 5500,
          driverName: 'Unknown',
          notes: null,
        },
      ],
    });
    expect(result.archivedBatchId).toBeNull();
    const batch = await getConfirmedBatchByPeriod(h.db, '2026-05');
    expect(batch!.id).toBe(result.batchId);
    const rows = await listClientRecordsByBatch(h.db, result.batchId);
    expect(rows).toHaveLength(2);
    expect(rows[0].fare).toBe(7680);
    expect(rows[1].driver_id).toBeNull();
  });

  it('同 period の二度目: overwrite=false → ConfirmedBatchAlreadyExistsError', async () => {
    await confirmImportBatch(h.db, baseInput('2026-05'));
    await expect(
      confirmImportBatch(h.db, baseInput('2026-05', false))
    ).rejects.toBeInstanceOf(ConfirmedBatchAlreadyExistsError);
  });

  it('overwrite=true で既存を archived 化して新規 confirmed を作成', async () => {
    const first = await confirmImportBatch(h.db, baseInput('2026-05'));
    const second = await confirmImportBatch(h.db, baseInput('2026-05', true));
    expect(second.archivedBatchId).toBe(first.batchId);
    const all = await listImportBatches(h.db, { period: '2026-05' });
    expect(all.map((b) => b.status).sort()).toEqual(['archived', 'confirmed']);
  });

  it('別 period なら独立に confirmed を持てる', async () => {
    await confirmImportBatch(h.db, baseInput('2026-05'));
    await confirmImportBatch(h.db, baseInput('2026-06'));
    expect((await listImportBatches(h.db)).length).toBe(2);
  });
});

describe('listClientRecordsByDriverPeriod', () => {
  it('confirmed バッチの当該ドライバー行のみ返す', async () => {
    const a = await createDriver(h.db, { name: 'A' });
    const b = await createDriver(h.db, { name: 'B' });
    await confirmImportBatch(h.db, {
      ...baseInput('2026-05'),
      rows: [
        baseRowFor(a.id, 1, 7000),
        baseRowFor(b.id, 2, 8000),
        baseRowFor(a.id, 3, null),
      ],
    });
    const rows = await listClientRecordsByDriverPeriod(h.db, a.id, '2026-05');
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.work_day).sort()).toEqual([1, 3]);
  });

  it('archived バッチの行は返さない（overwrite後）', async () => {
    const a = await createDriver(h.db, { name: 'A' });
    await confirmImportBatch(h.db, {
      ...baseInput('2026-05'),
      rows: [baseRowFor(a.id, 1, 1000)],
    });
    await confirmImportBatch(h.db, {
      ...baseInput('2026-05', true),
      rows: [baseRowFor(a.id, 1, 2000)],
    });
    const rows = await listClientRecordsByDriverPeriod(h.db, a.id, '2026-05');
    expect(rows.length).toBe(1);
    expect(rows[0].fare).toBe(2000);
  });
});

describe('import_previews', () => {
  it('create → get → 期限切れ削除', async () => {
    await createImportPreview(h.db, {
      previewId: 'p1',
      period: '2026-05',
      fileName: 'f.xlsx',
      rowCount: 100,
      summaryJson: '{}',
      r2Key: 'preview/p1.json',
      createdBy: 'staff-1',
      expiresAt: '2020-01-01T00:00:00+09:00',
    });
    await createImportPreview(h.db, {
      previewId: 'p2',
      period: '2026-05',
      fileName: 'f.xlsx',
      rowCount: 100,
      summaryJson: '{}',
      r2Key: 'preview/p2.json',
      createdBy: 'staff-1',
      expiresAt: '2099-01-01T00:00:00+09:00',
    });
    expect((await getImportPreview(h.db, 'p1'))).not.toBeNull();
    const cleaned = await deleteExpiredImportPreviews(h.db, '2026-05-20T00:00:00+09:00');
    expect(cleaned.rowsDeleted).toBe(1);
    expect(cleaned.r2Keys).toEqual(['preview/p1.json']);
    expect(await getImportPreview(h.db, 'p1')).toBeNull();
    expect(await getImportPreview(h.db, 'p2')).not.toBeNull();
  });
});

function baseRowFor(driverId: string | null, workDay: number, fare: number | null) {
  return {
    driverId,
    workDay,
    dayOfWeek: null,
    taskName: null,
    pickupLocation: null,
    deliveryLocation: null,
    startTime: null,
    endTime: null,
    distanceKm: null,
    advancePayment: 0,
    fare,
    driverName: null,
    notes: null,
  };
}
