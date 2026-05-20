// STEELO Phase 1: import_batches / client_records / import_previews のクエリ関数
import { jstNow } from './utils.js';

export interface ImportBatchRow {
  id: string;
  period: string;
  file_name: string | null;
  total_records: number;
  total_fare: number;
  total_advance: number;
  header_vehicle_cost: number;
  header_processing_fee: number;
  header_prepayment: number;
  commission_rate: number;
  tax_rate: number;
  template_version: string | null;
  status: string;
  period_confirmed_key: string | null;
  imported_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

export interface ClientRecordRow {
  id: string;
  import_batch_id: string;
  driver_id: string | null;
  period: string;
  work_day: number;
  day_of_week: string | null;
  task_name: string | null;
  pickup_location: string | null;
  delivery_location: string | null;
  start_time: string | null;
  end_time: string | null;
  distance_km: number | null;
  advance_payment: number;
  fare: number | null;
  driver_name: string | null;
  notes: string | null;
  created_at: string;
}

export interface ImportPreviewRow {
  preview_id: string;
  period: string;
  file_name: string | null;
  row_count: number;
  summary_json: string;
  r2_key: string;
  created_by: string;
  created_at: string;
  expires_at: string;
}

export class ConfirmedBatchAlreadyExistsError extends Error {
  constructor(public period: string, public existingId: string) {
    super(`confirmed batch already exists for period ${period}`);
    this.name = 'ConfirmedBatchAlreadyExistsError';
  }
}

// =============================================================================
// import_previews
// =============================================================================

export async function createImportPreview(
  db: D1Database,
  input: {
    previewId: string;
    period: string;
    fileName: string | null;
    rowCount: number;
    summaryJson: string;
    r2Key: string;
    createdBy: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO import_previews
       (preview_id, period, file_name, row_count, summary_json, r2_key, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.previewId,
      input.period,
      input.fileName,
      input.rowCount,
      input.summaryJson,
      input.r2Key,
      input.createdBy,
      input.expiresAt
    )
    .run();
}

export async function getImportPreview(
  db: D1Database,
  previewId: string
): Promise<ImportPreviewRow | null> {
  return db
    .prepare(`SELECT * FROM import_previews WHERE preview_id = ?`)
    .bind(previewId)
    .first<ImportPreviewRow>();
}

export async function deleteImportPreview(
  db: D1Database,
  previewId: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM import_previews WHERE preview_id = ?`)
    .bind(previewId)
    .run();
}

/** scheduled() から呼ぶ。期限切れ preview を物理削除し、削除件数を返す */
export async function deleteExpiredImportPreviews(
  db: D1Database,
  now: string = jstNow()
): Promise<{ rowsDeleted: number; r2Keys: string[] }> {
  const target = await db
    .prepare(`SELECT preview_id, r2_key FROM import_previews WHERE expires_at < ?`)
    .bind(now)
    .all<{ preview_id: string; r2_key: string }>();
  const keys = target.results.map((r) => r.r2_key);
  if (target.results.length > 0) {
    const result = await db
      .prepare(`DELETE FROM import_previews WHERE expires_at < ?`)
      .bind(now)
      .run();
    const changes = (result.meta as { changes?: number }).changes ?? 0;
    return { rowsDeleted: changes, r2Keys: keys };
  }
  return { rowsDeleted: 0, r2Keys: [] };
}

// =============================================================================
// import_batches
// =============================================================================

export async function listImportBatches(
  db: D1Database,
  opts: { period?: string; status?: string } = {}
): Promise<ImportBatchRow[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.period) {
    where.push('period = ?');
    vals.push(opts.period);
  }
  if (opts.status) {
    where.push('status = ?');
    vals.push(opts.status);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await db
    .prepare(`SELECT * FROM import_batches ${w} ORDER BY imported_at DESC`)
    .bind(...vals)
    .all<ImportBatchRow>();
  return r.results;
}

export async function getImportBatchById(
  db: D1Database,
  id: string
): Promise<ImportBatchRow | null> {
  return db
    .prepare(`SELECT * FROM import_batches WHERE id = ?`)
    .bind(id)
    .first<ImportBatchRow>();
}

export async function getConfirmedBatchByPeriod(
  db: D1Database,
  period: string
): Promise<ImportBatchRow | null> {
  return db
    .prepare(`SELECT * FROM import_batches WHERE period = ? AND status = 'confirmed'`)
    .bind(period)
    .first<ImportBatchRow>();
}

export interface ConfirmImportBatchInput {
  period: string;
  fileName: string | null;
  totalRecords: number;
  totalFare: number;
  totalAdvance: number;
  headerVehicleCost: number;
  headerProcessingFee: number;
  headerPrepayment: number;
  commissionRate: number;
  taxRate: number;
  templateVersion: string | null;
  confirmedBy: string;
  rows: ClientRecordInput[];
  overwrite: boolean;
}

export interface ClientRecordInput {
  driverId: string | null;
  workDay: number;
  dayOfWeek: string | null;
  taskName: string | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  startTime: string | null;
  endTime: string | null;
  distanceKm: number | null;
  advancePayment: number;
  fare: number | null;
  driverName: string | null;
  notes: string | null;
}

/**
 * 確定処理を原子的に実行する。
 *
 *   1. 既存 confirmed の有無を確認
 *      - あり + overwrite=false → ConfirmedBatchAlreadyExistsError を throw
 *      - あり + overwrite=true → 既存を status='archived' に変更
 *   2. 新規 batch を status='confirmed' で INSERT（generated column UNIQUE が
 *      並行 confirm 時の競合を防ぐ）
 *   3. client_records を 50 行刻みで INSERT（D1 のパラメータ100制約に配慮）
 *   4. 旧バッチ ID と新バッチ ID を返す（呼び出し側で audit_logs を書く）
 *
 * 注: D1 はマルチステートメントのトランザクションを batch() API でしか提供しないが、
 * UNIQUE 制約による排他で並行 confirm の整合性は守られる。途中で失敗した場合は
 * 未完了の client_records が残るが、batch.status は pending/archived のままなので
 * 集計には影響しない（cleanup は運用で対応）。
 */
export async function confirmImportBatch(
  db: D1Database,
  input: ConfirmImportBatchInput
): Promise<{ batchId: string; archivedBatchId: string | null }> {
  const existing = await getConfirmedBatchByPeriod(db, input.period);
  let archivedBatchId: string | null = null;
  if (existing) {
    if (!input.overwrite) {
      throw new ConfirmedBatchAlreadyExistsError(input.period, existing.id);
    }
    archivedBatchId = existing.id;
    await db
      .prepare(
        `UPDATE import_batches SET status = 'archived' WHERE id = ?`
      )
      .bind(existing.id)
      .run();
  }
  const id = crypto.randomUUID();
  const now = jstNow();
  try {
    await db
      .prepare(
        `INSERT INTO import_batches
         (id, period, file_name, total_records, total_fare, total_advance,
          header_vehicle_cost, header_processing_fee, header_prepayment,
          commission_rate, tax_rate, template_version, status,
          imported_at, confirmed_at, confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`
      )
      .bind(
        id,
        input.period,
        input.fileName,
        input.totalRecords,
        input.totalFare,
        input.totalAdvance,
        input.headerVehicleCost,
        input.headerProcessingFee,
        input.headerPrepayment,
        input.commissionRate,
        input.taxRate,
        input.templateVersion,
        now,
        now,
        input.confirmedBy
      )
      .run();
  } catch (e) {
    // 並行 confirm: 上の overwrite 分岐を抜けてもまだ別 worker が confirmed を
    // 入れることがある（generated column UNIQUE で2件目を弾く）
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ConfirmedBatchAlreadyExistsError(input.period, '<concurrent>');
    }
    throw e;
  }
  await insertClientRecords(db, id, input.period, input.rows);
  return { batchId: id, archivedBatchId };
}

async function insertClientRecords(
  db: D1Database,
  batchId: string,
  period: string,
  rows: ClientRecordInput[]
): Promise<void> {
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const statements = chunk.map((r) =>
      db
        .prepare(
          `INSERT INTO client_records
           (id, import_batch_id, driver_id, period, work_day, day_of_week,
            task_name, pickup_location, delivery_location, start_time, end_time,
            distance_km, advance_payment, fare, driver_name, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          batchId,
          r.driverId,
          period,
          r.workDay,
          r.dayOfWeek,
          r.taskName,
          r.pickupLocation,
          r.deliveryLocation,
          r.startTime,
          r.endTime,
          r.distanceKm,
          r.advancePayment,
          r.fare,
          r.driverName,
          r.notes
        )
    );
    if (statements.length > 0) {
      await db.batch(statements);
    }
  }
}

// =============================================================================
// client_records 読み取り
// =============================================================================

export async function listClientRecordsByBatch(
  db: D1Database,
  batchId: string
): Promise<ClientRecordRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM client_records WHERE import_batch_id = ?
       ORDER BY work_day ASC, id ASC`
    )
    .bind(batchId)
    .all<ClientRecordRow>();
  return r.results;
}

export async function listClientRecordsByDriverPeriod(
  db: D1Database,
  driverId: string,
  period: string
): Promise<ClientRecordRow[]> {
  const r = await db
    .prepare(
      `SELECT cr.* FROM client_records cr
       INNER JOIN import_batches b ON b.id = cr.import_batch_id
       WHERE cr.driver_id = ? AND cr.period = ? AND b.status = 'confirmed'
       ORDER BY cr.work_day ASC, cr.id ASC`
    )
    .bind(driverId, period)
    .all<ClientRecordRow>();
  return r.results;
}
