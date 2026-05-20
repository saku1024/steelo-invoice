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
  /**
   * confirm/overwrite を行ったことを audit_logs に記録するためのコンテキスト。
   * confirmImportBatch は最後の status='confirmed' UPDATE と一緒に
   * D1 batch で書き込む（Codex impl review MEDIUM #11 反映）。
   * 省略時は audit を書かない（ルート側で呼んでも良いが trans 跨ぎになる）。
   */
  audit?: {
    actorId: string;
    actorName: string;
    ip: string | null;
    userAgent: string | null;
  };
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
 * 確定処理を原子化された手順で実行する。
 *
 * Codex impl review CRITICAL #2/#3 反映:
 *   旧来は「旧 confirmed → archived → 新 confirmed INSERT → client_records INSERT」
 *   の順で実行し、途中失敗時に「period に有効な confirmed が無い」状態や
 *   「行欠損の confirmed バッチが残る」状態が起きえた。新フローは:
 *
 *   1. 新バッチを **pending** で INSERT
 *   2. client_records を全件 INSERT（途中失敗時は pending のまま残るが、
 *      集計対象（status='confirmed'）からは外れるので支払計算に影響しない）
 *   3. 旧 confirmed を archived に、新 pending を confirmed に **同一 batch** で更新
 *      → generated column UNIQUE による並行排他は最後の UPDATE 時点でも効く
 *
 * 並行 confirm でも、最後の UPDATE 時に period_confirmed_key 衝突で UNIQUE 違反となり
 * 後勝ちが避けられる。
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
  }

  const id = crypto.randomUUID();
  const now = jstNow();

  // 1. 新バッチを pending で INSERT
  await db
    .prepare(
      `INSERT INTO import_batches
       (id, period, file_name, total_records, total_fare, total_advance,
        header_vehicle_cost, header_processing_fee, header_prepayment,
        commission_rate, tax_rate, template_version, status,
        imported_at, confirmed_at, confirmed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`
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
      now
    )
    .run();

  // 2. client_records を全件 INSERT
  try {
    await insertClientRecords(db, id, input.period, input.rows);
  } catch (e) {
    // 失敗時は pending バッチを掃除する
    try {
      await db.prepare(`DELETE FROM import_batches WHERE id = ?`).bind(id).run();
    } catch {
      /* ignore cleanup error */
    }
    throw e;
  }

  // 3. 旧 archived + 新 confirmed + audit_logs を D1 batch() で同時実行
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    stmts.push(
      db
        .prepare(`UPDATE import_batches SET status = 'archived' WHERE id = ?`)
        .bind(existing.id)
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE import_batches SET status = 'confirmed',
           confirmed_at = ?, confirmed_by = ? WHERE id = ?`
      )
      .bind(now, input.confirmedBy, id)
  );
  if (input.audit) {
    const auditAction = existing ? 'import_overwrite' : 'import_confirm';
    stmts.push(
      db
        .prepare(
          `INSERT INTO audit_logs
             (id, actor_id, actor_name, action, resource_type, resource_id,
              payload_json, ip, user_agent)
             VALUES (?, ?, ?, ?, 'import_batch', ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.audit.actorId,
          input.audit.actorName,
          auditAction,
          id,
          JSON.stringify({
            period: input.period,
            archived: archivedBatchId,
            rowCount: input.rows.length,
          }),
          input.audit.ip,
          input.audit.userAgent
        )
    );
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    // 並行 confirm 等で UNIQUE 違反 → pending バッチと client_records を掃除
    try {
      await db.prepare(`DELETE FROM client_records WHERE import_batch_id = ?`).bind(id).run();
      await db.prepare(`DELETE FROM import_batches WHERE id = ?`).bind(id).run();
    } catch {
      /* ignore */
    }
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ConfirmedBatchAlreadyExistsError(input.period, existing?.id ?? '<concurrent>');
    }
    throw e;
  }
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
