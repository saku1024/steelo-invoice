// STEELO Phase 1: driver_deductions のクエリ関数
import { jstNow } from './utils.js';

export interface DriverDeductionRow {
  id: string;
  driver_id: string;
  period: string;
  vehicle_cost: number;
  processing_fee: number;
  prepayment: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface UpsertDriverDeductionInput {
  driverId: string;
  period: string;
  vehicleCost: number;
  processingFee: number;
  prepayment: number;
  notes?: string | null;
  updatedBy?: string | null;
}

export async function listDriverDeductions(
  db: D1Database,
  opts: { period?: string; driverId?: string } = {}
): Promise<DriverDeductionRow[]> {
  if (opts.period && opts.driverId) {
    const r = await db
      .prepare(`SELECT * FROM driver_deductions WHERE period = ? AND driver_id = ?`)
      .bind(opts.period, opts.driverId)
      .all<DriverDeductionRow>();
    return r.results;
  }
  if (opts.period) {
    const r = await db
      .prepare(`SELECT * FROM driver_deductions WHERE period = ? ORDER BY driver_id ASC`)
      .bind(opts.period)
      .all<DriverDeductionRow>();
    return r.results;
  }
  if (opts.driverId) {
    const r = await db
      .prepare(`SELECT * FROM driver_deductions WHERE driver_id = ? ORDER BY period DESC`)
      .bind(opts.driverId)
      .all<DriverDeductionRow>();
    return r.results;
  }
  const r = await db
    .prepare(`SELECT * FROM driver_deductions ORDER BY period DESC, driver_id ASC`)
    .all<DriverDeductionRow>();
  return r.results;
}

export async function getDriverDeduction(
  db: D1Database,
  driverId: string,
  period: string
): Promise<DriverDeductionRow | null> {
  return db
    .prepare(`SELECT * FROM driver_deductions WHERE driver_id = ? AND period = ?`)
    .bind(driverId, period)
    .first<DriverDeductionRow>();
}

export async function upsertDriverDeduction(
  db: D1Database,
  input: UpsertDriverDeductionInput
): Promise<DriverDeductionRow> {
  const existing = await getDriverDeduction(db, input.driverId, input.period);
  const now = jstNow();
  if (existing) {
    await db
      .prepare(
        `UPDATE driver_deductions
         SET vehicle_cost = ?, processing_fee = ?, prepayment = ?,
             notes = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`
      )
      .bind(
        input.vehicleCost,
        input.processingFee,
        input.prepayment,
        input.notes ?? null,
        now,
        input.updatedBy ?? null,
        existing.id
      )
      .run();
    return (await getDriverDeduction(db, input.driverId, input.period))!;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO driver_deductions
       (id, driver_id, period, vehicle_cost, processing_fee, prepayment,
        notes, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.driverId,
      input.period,
      input.vehicleCost,
      input.processingFee,
      input.prepayment,
      input.notes ?? null,
      now,
      now,
      input.updatedBy ?? null
    )
    .run();
  return (await getDriverDeduction(db, input.driverId, input.period))!;
}
