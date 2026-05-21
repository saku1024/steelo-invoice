// STEELO Phase 3 F10: report_jobs のクエリヘルパ
//
// Phase 2 reconciliation_jobs と同パターン (active_report_key UNIQUE + stuck recovery)。
// Codex Phase 3 round 1 CRITICAL #6 / round 2 HIGH #5 反映:
//   - report_type ごとの必須 source ID を createJob 時点でチェック (422 fail)
//   - active_report_key (period + type) UNIQUE で同 period × type 二重起動を排他
//   - cron `*/5` で 30 分以上 running の job を failed にリカバリ
import { jstNow } from './utils.js';

export type ReportType = 'reconciliation' | 'client_summary' | 'payment_summary';
export type ReportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ReportJobRow {
  id: string;
  period: string;
  report_type: string;
  status: string;
  template_version: number;
  r2_key: string | null;
  byte_size: number | null;
  page_count: number | null;
  source_import_batch_id: string | null;
  source_reconciliation_job_id: string | null;
  source_payment_job_id: string | null;
  error_message: string | null;
  requested_by: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  active_report_key: string | null;
}

export class ActiveReportJobExistsError extends Error {
  constructor(public period: string, public reportType: string) {
    super(`active report job already exists for ${period}:${reportType}`);
    this.name = 'ActiveReportJobExistsError';
  }
}

export class ReportSourceMissingError extends Error {
  constructor(public reportType: string, public period: string) {
    super(`required source not found for ${reportType} in ${period}`);
    this.name = 'ReportSourceMissingError';
  }
}

export interface CreateReportJobInput {
  period: string;
  reportType: ReportType;
  templateVersion: number;
  requestedBy: string;
}

/**
 * report_type ごとの必須 source を解決して INSERT する。
 * - reconciliation: 該当 period の `status='completed'` 最新 reconciliation_jobs
 * - client_summary: 該当 period の `status='confirmed'` 最新 import_batches
 * - payment_summary: Phase 3 では実装着手前に再評価のため throw
 *
 * source が無ければ ReportSourceMissingError (route 側で 422 にマップ)。
 * UNIQUE 違反は ActiveReportJobExistsError (409 にマップ)。
 */
export async function createReportJob(
  db: D1Database,
  input: CreateReportJobInput,
): Promise<ReportJobRow> {
  const { period, reportType } = input;

  // source 解決
  let sourceReconJobId: string | null = null;
  let sourceImportBatchId: string | null = null;
  let sourcePaymentJobId: string | null = null;

  if (reportType === 'reconciliation') {
    const row = await db
      .prepare(
        `SELECT id FROM reconciliation_jobs
         WHERE period = ? AND status = 'completed'
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .bind(period)
      .first<{ id: string }>();
    if (!row) throw new ReportSourceMissingError(reportType, period);
    sourceReconJobId = row.id;
  } else if (reportType === 'client_summary') {
    const row = await db
      .prepare(
        `SELECT id FROM import_batches
         WHERE period = ? AND status = 'confirmed'
         ORDER BY confirmed_at DESC LIMIT 1`,
      )
      .bind(period)
      .first<{ id: string }>();
    if (!row) throw new ReportSourceMissingError(reportType, period);
    sourceImportBatchId = row.id;
  } else if (reportType === 'payment_summary') {
    // Phase 3 では実装着手前に再評価 (driver_payment_summaries が upsert で
    // immutable snapshot にならないため、設計再検討が必要)
    throw new Error(
      'payment_summary report type is not yet supported in Phase 3 (P2 deferred)',
    );
  }

  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO report_jobs
           (id, period, report_type, status, template_version,
            source_import_batch_id, source_reconciliation_job_id,
            source_payment_job_id, requested_by)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        period,
        reportType,
        input.templateVersion,
        sourceImportBatchId,
        sourceReconJobId,
        sourcePaymentJobId,
        input.requestedBy,
      )
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ActiveReportJobExistsError(period, reportType);
    }
    throw e;
  }
  return (await getReportJobById(db, id))!;
}

export async function getReportJobById(
  db: D1Database,
  id: string,
): Promise<ReportJobRow | null> {
  return db
    .prepare(`SELECT * FROM report_jobs WHERE id = ?`)
    .bind(id)
    .first<ReportJobRow>();
}

export async function tryMarkReportJobRunning(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE report_jobs SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .bind(jstNow(), id)
    .run();
  return ((r.meta as { changes?: number }).changes ?? 0) === 1;
}

export async function markReportJobCompleted(
  db: D1Database,
  id: string,
  result: { r2Key: string; byteSize: number; pageCount: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE report_jobs SET status = 'completed', completed_at = ?,
       r2_key = ?, byte_size = ?, page_count = ? WHERE id = ?`,
    )
    .bind(jstNow(), result.r2Key, result.byteSize, result.pageCount, id)
    .run();
}

export async function markReportJobFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE report_jobs SET status = 'failed', completed_at = ?,
       error_message = ? WHERE id = ?`,
    )
    .bind(jstNow(), errorMessage.slice(0, 2000), id)
    .run();
}

export async function getQueuedReportJobs(
  db: D1Database,
  limit = 3,
): Promise<ReportJobRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM report_jobs WHERE status = 'queued'
       ORDER BY requested_at ASC LIMIT ?`,
    )
    .bind(limit)
    .all<ReportJobRow>();
  return r.results;
}

/**
 * 30 分以上 running の report_jobs を failed に倒す (Codex round 1 CRITICAL #6)。
 * Phase 2 reconciliation_jobs と同パターン。
 */
export async function recoverStuckReportJobs(
  db: D1Database,
  staleThresholdMinutes = 30,
): Promise<number> {
  const cutoffMs = Date.now() - staleThresholdMinutes * 60_000;
  const r = await db
    .prepare(`SELECT id, started_at FROM report_jobs WHERE status = 'running'`)
    .all<{ id: string; started_at: string | null }>();
  const stuck: string[] = [];
  for (const row of r.results) {
    if (!row.started_at) {
      stuck.push(row.id);
      continue;
    }
    const t = new Date(row.started_at).getTime();
    if (!Number.isNaN(t) && t < cutoffMs) stuck.push(row.id);
  }
  if (stuck.length === 0) return 0;
  const now = jstNow();
  const stmts = stuck.map((id) =>
    db
      .prepare(
        `UPDATE report_jobs SET status = 'failed',
           error_message = COALESCE(error_message, 'recovered from stuck running'),
           completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .bind(now, id),
  );
  await db.batch(stmts);
  return stuck.length;
}

export interface ListReportJobsOptions {
  period?: string;
  status?: ReportJobStatus;
  limit?: number;
}

export async function listReportJobs(
  db: D1Database,
  opts: ListReportJobsOptions = {},
): Promise<ReportJobRow[]> {
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
  const w = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 200);
  vals.push(limit);
  const r = await db
    .prepare(`SELECT * FROM report_jobs ${w} ORDER BY requested_at DESC LIMIT ?`)
    .bind(...vals)
    .all<ReportJobRow>();
  return r.results;
}
