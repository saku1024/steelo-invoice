// STEELO Phase 1: driver_payment_summaries / payment_summary_lines / payment_jobs
import { jstNow } from './utils.js';

export interface DriverPaymentSummaryRow {
  id: string;
  driver_id: string;
  period: string;
  import_batch_id: string;
  payment_job_id: string | null;
  driver_name_snapshot: string;
  has_invoice_snapshot: number;
  commission_rate_snapshot: number;
  tax_rate_snapshot: number;
  rounding_rule: string;
  total_fare_before_tax: number;
  total_fare_with_tax: number;
  total_advance: number;
  vehicle_cost: number;
  processing_fee: number;
  prepayment: number;
  final_amount: number;
  r2_xlsx_key: string | null;
  generated_at: string;
}

export interface PaymentSummaryLineRow {
  id: string;
  summary_id: string;
  client_record_id: string | null;
  work_day: number;
  task_name: string | null;
  fare: number | null;
  fare_after_commission: number | null;
  fare_with_tax: number | null;
  advance_payment: number;
  excluded_from_calc: number;
}

export interface PaymentJobRow {
  id: string;
  period: string;
  status: string;
  progress: number;
  total_drivers: number;
  done_drivers: number;
  r2_zip_key: string | null;
  error_message: string | null;
  requested_by: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  active_period_key: string | null;
}

// =============================================================================
// driver_payment_summaries (UPSERT)
// =============================================================================

export interface UpsertSummaryInput {
  driverId: string;
  period: string;
  importBatchId: string;
  paymentJobId: string | null;
  driverNameSnapshot: string;
  hasInvoiceSnapshot: boolean;
  commissionRateSnapshot: number;
  taxRateSnapshot: number;
  totalFareBeforeTax: number;
  totalFareWithTax: number;
  totalAdvance: number;
  vehicleCost: number;
  processingFee: number;
  prepayment: number;
  finalAmount: number;
  r2XlsxKey: string | null;
}

export async function upsertDriverPaymentSummary(
  db: D1Database,
  input: UpsertSummaryInput
): Promise<DriverPaymentSummaryRow> {
  const now = jstNow();
  const existing = await db
    .prepare(
      `SELECT * FROM driver_payment_summaries WHERE driver_id = ? AND period = ?`
    )
    .bind(input.driverId, input.period)
    .first<DriverPaymentSummaryRow>();
  if (existing) {
    await db
      .prepare(
        `UPDATE driver_payment_summaries SET
           import_batch_id = ?,
           payment_job_id = ?,
           driver_name_snapshot = ?,
           has_invoice_snapshot = ?,
           commission_rate_snapshot = ?,
           tax_rate_snapshot = ?,
           total_fare_before_tax = ?,
           total_fare_with_tax = ?,
           total_advance = ?,
           vehicle_cost = ?,
           processing_fee = ?,
           prepayment = ?,
           final_amount = ?,
           r2_xlsx_key = ?,
           generated_at = ?
         WHERE id = ?`
      )
      .bind(
        input.importBatchId,
        input.paymentJobId,
        input.driverNameSnapshot,
        input.hasInvoiceSnapshot ? 1 : 0,
        input.commissionRateSnapshot,
        input.taxRateSnapshot,
        input.totalFareBeforeTax,
        input.totalFareWithTax,
        input.totalAdvance,
        input.vehicleCost,
        input.processingFee,
        input.prepayment,
        input.finalAmount,
        input.r2XlsxKey,
        now,
        existing.id
      )
      .run();
    // 旧 summary_lines を削除（CASCADE 任せでも良いが明示）
    await db
      .prepare(`DELETE FROM payment_summary_lines WHERE summary_id = ?`)
      .bind(existing.id)
      .run();
    return (await getDriverPaymentSummaryById(db, existing.id))!;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO driver_payment_summaries
       (id, driver_id, period, import_batch_id, payment_job_id,
        driver_name_snapshot, has_invoice_snapshot,
        commission_rate_snapshot, tax_rate_snapshot, rounding_rule,
        total_fare_before_tax, total_fare_with_tax, total_advance,
        vehicle_cost, processing_fee, prepayment, final_amount,
        r2_xlsx_key, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'per_line_round',
               ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.driverId,
      input.period,
      input.importBatchId,
      input.paymentJobId,
      input.driverNameSnapshot,
      input.hasInvoiceSnapshot ? 1 : 0,
      input.commissionRateSnapshot,
      input.taxRateSnapshot,
      input.totalFareBeforeTax,
      input.totalFareWithTax,
      input.totalAdvance,
      input.vehicleCost,
      input.processingFee,
      input.prepayment,
      input.finalAmount,
      input.r2XlsxKey,
      now
    )
    .run();
  return (await getDriverPaymentSummaryById(db, id))!;
}

export async function getDriverPaymentSummaryById(
  db: D1Database,
  id: string
): Promise<DriverPaymentSummaryRow | null> {
  return db
    .prepare(`SELECT * FROM driver_payment_summaries WHERE id = ?`)
    .bind(id)
    .first<DriverPaymentSummaryRow>();
}

export async function listDriverPaymentSummariesByJobId(
  db: D1Database,
  jobId: string
): Promise<DriverPaymentSummaryRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM driver_payment_summaries WHERE payment_job_id = ?
       ORDER BY driver_name_snapshot ASC`
    )
    .bind(jobId)
    .all<DriverPaymentSummaryRow>();
  return r.results;
}

export async function listDriverPaymentSummariesByPeriod(
  db: D1Database,
  period: string
): Promise<DriverPaymentSummaryRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM driver_payment_summaries
       WHERE period = ?
       ORDER BY driver_name_snapshot ASC`
    )
    .bind(period)
    .all<DriverPaymentSummaryRow>();
  return r.results;
}

export async function updateSummaryR2Key(
  db: D1Database,
  summaryId: string,
  r2Key: string
): Promise<void> {
  await db
    .prepare(`UPDATE driver_payment_summaries SET r2_xlsx_key = ? WHERE id = ?`)
    .bind(r2Key, summaryId)
    .run();
}

// =============================================================================
// payment_summary_lines
// =============================================================================

export interface SummaryLineInput {
  summaryId: string;
  clientRecordId: string | null;
  workDay: number;
  taskName: string | null;
  fare: number | null;
  fareAfterCommission: number | null;
  fareWithTax: number | null;
  advancePayment: number;
  excludedFromCalc: boolean;
}

export async function insertSummaryLines(
  db: D1Database,
  lines: SummaryLineInput[]
): Promise<void> {
  if (lines.length === 0) return;
  const BATCH = 50;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const statements = chunk.map((l) =>
      db
        .prepare(
          `INSERT INTO payment_summary_lines
           (id, summary_id, client_record_id, work_day, task_name,
            fare, fare_after_commission, fare_with_tax,
            advance_payment, excluded_from_calc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          l.summaryId,
          l.clientRecordId,
          l.workDay,
          l.taskName,
          l.fare,
          l.fareAfterCommission,
          l.fareWithTax,
          l.advancePayment,
          l.excludedFromCalc ? 1 : 0
        )
    );
    await db.batch(statements);
  }
}

export async function listSummaryLines(
  db: D1Database,
  summaryId: string
): Promise<PaymentSummaryLineRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM payment_summary_lines WHERE summary_id = ?
       ORDER BY work_day ASC, id ASC`
    )
    .bind(summaryId)
    .all<PaymentSummaryLineRow>();
  return r.results;
}

// =============================================================================
// payment_jobs
// =============================================================================

export class ActiveJobAlreadyExistsError extends Error {
  constructor(public period: string) {
    super(`active payment job already exists for period ${period}`);
    this.name = 'ActiveJobAlreadyExistsError';
  }
}

export async function createPaymentJob(
  db: D1Database,
  input: { period: string; requestedBy: string; totalDrivers: number }
): Promise<PaymentJobRow> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO payment_jobs (id, period, status, total_drivers, requested_by)
         VALUES (?, ?, 'queued', ?, ?)`
      )
      .bind(id, input.period, input.totalDrivers, input.requestedBy)
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ActiveJobAlreadyExistsError(input.period);
    }
    throw e;
  }
  return (await getPaymentJobById(db, id))!;
}

export async function getPaymentJobById(
  db: D1Database,
  id: string
): Promise<PaymentJobRow | null> {
  return db
    .prepare(`SELECT * FROM payment_jobs WHERE id = ?`)
    .bind(id)
    .first<PaymentJobRow>();
}

export async function getQueuedPaymentJobs(
  db: D1Database,
  limit = 5
): Promise<PaymentJobRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM payment_jobs WHERE status = 'queued'
       ORDER BY requested_at ASC LIMIT ?`
    )
    .bind(limit)
    .all<PaymentJobRow>();
  return r.results;
}

/**
 * `running` で長時間動いていない（worker クラッシュ等で取り残された）ジョブを
 * `failed` に倒して active_period_key UNIQUE を解放する。
 * Codex impl review HIGH #9 反映 / verify HIGH #1 反映:
 *   started_at は `+09:00` 形式で保存されているため、SQL の文字列比較では
 *   `Z` 形式 cutoff と整合しない。SELECT で取得後 JS 側で epoch 比較する。
 */
export async function recoverStuckPaymentJobs(
  db: D1Database,
  staleThresholdMinutes = 30
): Promise<number> {
  const cutoffMs = Date.now() - staleThresholdMinutes * 60_000;
  // started_at が null（running 化前に落ちた）or 古いものを候補にする
  const r = await db
    .prepare(`SELECT id, started_at FROM payment_jobs WHERE status = 'running'`)
    .all<{ id: string; started_at: string | null }>();
  const stuck: string[] = [];
  for (const row of r.results) {
    if (!row.started_at) {
      stuck.push(row.id);
      continue;
    }
    const t = new Date(row.started_at).getTime();
    if (!Number.isNaN(t) && t < cutoffMs) {
      stuck.push(row.id);
    }
  }
  if (stuck.length === 0) return 0;
  const now = jstNow();
  const stmts = stuck.map((id) =>
    db
      .prepare(
        `UPDATE payment_jobs SET status = 'failed',
           error_message = COALESCE(error_message, 'recovered from stuck running'),
           completed_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .bind(now, id)
  );
  await db.batch(stmts);
  return stuck.length;
}

/**
 * queued → running への遷移を条件付き UPDATE で原子化する。
 * 複数 invocation が同時に queued を読んでも、`changes === 1` の側だけが
 * 処理に進める（Codex impl review HIGH #8 反映）。
 */
export async function tryMarkPaymentJobRunning(
  db: D1Database,
  id: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE payment_jobs SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .bind(jstNow(), id)
    .run();
  const changes = (result.meta as { changes?: number }).changes ?? 0;
  return changes === 1;
}

/** 旧 API（テストやレガシー呼び出し用）。新規利用は tryMarkPaymentJobRunning を推奨 */
export async function markPaymentJobRunning(db: D1Database, id: string): Promise<void> {
  await tryMarkPaymentJobRunning(db, id);
}

export async function updatePaymentJobProgress(
  db: D1Database,
  id: string,
  doneDrivers: number,
  totalDrivers: number
): Promise<void> {
  const progress = totalDrivers > 0 ? Math.round((doneDrivers / totalDrivers) * 100) : 0;
  await db
    .prepare(
      `UPDATE payment_jobs SET done_drivers = ?, progress = ? WHERE id = ?`
    )
    .bind(doneDrivers, progress, id)
    .run();
}

export async function markPaymentJobCompleted(
  db: D1Database,
  id: string,
  r2ZipKey: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE payment_jobs SET status = 'completed', progress = 100,
       r2_zip_key = ?, completed_at = ? WHERE id = ?`
    )
    .bind(r2ZipKey, jstNow(), id)
    .run();
}

export async function markPaymentJobFailed(
  db: D1Database,
  id: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE payment_jobs SET status = 'failed', error_message = ?,
       completed_at = ? WHERE id = ?`
    )
    .bind(error.slice(0, 2000), jstNow(), id)
    .run();
}
