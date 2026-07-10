// STEELO Phase 2: reconciliations / reconciliation_jobs クエリ関数
import { jstNow } from './utils.js';

export interface ReconciliationRow {
  id: string;
  period: string;
  reconciliation_job_id: string | null;
  dispatch_id: string | null;
  client_record_id: string | null;
  match_status: string;
  match_method: string;
  match_score: number;
  warnings: string | null;
  status: string;
  reviewed: number;
  reviewed_at: string | null;
  reviewed_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface ReconciliationJobRow {
  id: string;
  period: string;
  status: string;
  progress: number;
  dispatch_count: number;
  client_count: number;
  matched_count: number;
  client_only_count: number;
  dispatch_only_count: number;
  error_message: string | null;
  requested_by: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  active_period_key: string | null;
}

/**
 * Phase 3: warnings は Phase 2 の string[] から JSON serialize 済み文字列に変更。
 * 呼び出し側 (reconciliation-job 等) が `serializeWarnings()` で StructuredWarning[]
 * を JSON 文字列に変換してから渡す。null = warning 無し。
 */
export interface InsertReconciliationInput {
  period: string;
  reconciliationJobId: string;
  dispatchId: string | null;
  clientRecordId: string | null;
  matchStatus: 'matched' | 'client_only' | 'dispatch_only';
  matchMethod: 'strong' | 'fuzzy' | 'time' | 'none' | 'manual';
  matchScore: number;
  warningsJson: string | null;
}

// =============================================================================
// reconciliations
// =============================================================================

/**
 * 旧 reconciliations を archived に倒す。reviewed=1 のものは archived_reviewed に
 * 振り分けて再 review を促せるようにする。
 *
 * Codex Phase 2 review CRITICAL #3 反映:
 *   archive と insert の確定境界を分けるとデータが消えるリスクがあるため、
 *   この関数は単体で使わず、commitReconciliationsAtomic() から呼ぶこと。
 */
async function buildArchiveStatements(
  db: D1Database,
  period: string
): Promise<{ stmts: D1PreparedStatement[]; toArchive: number; toReview: number }> {
  // 該当件数を事前に取得（カウントだけ）
  const a = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM reconciliations
       WHERE period = ? AND status = 'active' AND reviewed = 0`
    )
    .bind(period)
    .first<{ n: number }>();
  const b = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM reconciliations
       WHERE period = ? AND status = 'active' AND reviewed = 1`
    )
    .bind(period)
    .first<{ n: number }>();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE reconciliations SET status = 'archived'
         WHERE period = ? AND status = 'active' AND reviewed = 0`
      )
      .bind(period),
    db
      .prepare(
        `UPDATE reconciliations SET status = 'archived_reviewed'
         WHERE period = ? AND status = 'active' AND reviewed = 1`
      )
      .bind(period),
  ];
  return { stmts, toArchive: a?.n ?? 0, toReview: b?.n ?? 0 };
}

/**
 * @deprecated commitReconciliationsAtomic を使うこと。下位互換のため残す。
 */
export async function archivePriorReconciliations(
  db: D1Database,
  period: string
): Promise<{ archived: number; archivedReviewed: number }> {
  const { stmts, toArchive, toReview } = await buildArchiveStatements(db, period);
  await db.batch(stmts);
  return { archived: toArchive, archivedReviewed: toReview };
}

/**
 * @deprecated commitReconciliationsAtomic を使うこと。テスト互換のため残す。
 */
export async function insertReconciliations(
  db: D1Database,
  rows: InsertReconciliationInput[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const stmts = chunk.map((r) => buildInsertStatement(db, r));
    await db.batch(stmts);
    inserted += chunk.length;
  }
  return inserted;
}

function buildInsertStatement(
  db: D1Database,
  r: InsertReconciliationInput,
  status: 'active' | 'pending' = 'active'
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reconciliations
       (id, period, reconciliation_job_id, dispatch_id, client_record_id,
        match_status, match_method, match_score, warnings, status, reviewed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(
      crypto.randomUUID(),
      r.period,
      r.reconciliationJobId,
      r.dispatchId,
      r.clientRecordId,
      r.matchStatus,
      r.matchMethod,
      r.matchScore,
      r.warningsJson,
      status
    );
}

/**
 * 月次照合結果を確定する。以前の実装は「旧 active → archived」の batch と
 * 「新 active を INSERT」の batch が別トランザクションになっており、
 * 第1バッチ後・第2バッチ前に Worker が中断すると period が一時的に
 * active 0 件になりうる非原子的な処理だった（Codex Phase2 review CRITICAL #3
 * で「原子的」と称していたが実際には保証されていなかった）。
 *
 * 修正後は2段階に分ける:
 *   1. 新しい行を status='pending' として INSERT する。pending は
 *      listReconciliations 等どのクエリからも明示指定でしか見えないため、
 *      ここで何件失敗しても旧 active には一切影響しない
 *      （import-batch の pending→confirmed と同じ「不可視ステージング」パターン）。
 *   2. 「旧 active → archived」+「新 pending → active」の切替を
 *      **単一の db.batch()（=単一トランザクション）** で行う。
 *      ステートメント数は常に 3 件で行数に依存しないため D1 のバッチ
 *      ステートメント数上限に触れることがなく、真に原子的。
 */
export async function commitReconciliationsAtomic(
  db: D1Database,
  period: string,
  rows: InsertReconciliationInput[]
): Promise<{ archived: number; archivedReviewed: number; inserted: number }> {
  // 前回失敗時に取り残された pending 行があれば掃除してから開始する
  await db
    .prepare(`DELETE FROM reconciliations WHERE period = ? AND status = 'pending'`)
    .bind(period)
    .run();

  // 段階1: 新しい行を非公開の pending として INSERT
  let inserted = 0;
  if (rows.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const stmts = chunk.map((r) => buildInsertStatement(db, r, 'pending'));
      await db.batch(stmts);
      inserted += chunk.length;
    }
  }

  // 段階2: archive + pending→active の切替を単一トランザクションで実行
  const { stmts: archiveStmts, toArchive, toReview } = await buildArchiveStatements(
    db,
    period
  );
  await db.batch([
    ...archiveStmts,
    db
      .prepare(`UPDATE reconciliations SET status = 'active' WHERE period = ? AND status = 'pending'`)
      .bind(period),
  ]);

  return { archived: toArchive, archivedReviewed: toReview, inserted };
}

export interface ListReconciliationsOptions {
  period: string;
  status?: 'active' | 'archived' | 'archived_reviewed';
  matchStatus?: 'matched' | 'client_only' | 'dispatch_only';
  reviewed?: boolean;
  limit?: number;
  offset?: number;
}

export async function listReconciliations(
  db: D1Database,
  opts: ListReconciliationsOptions
): Promise<{ items: ReconciliationRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const where: string[] = ['period = ?'];
  const vals: unknown[] = [opts.period];
  where.push('status = ?');
  vals.push(opts.status ?? 'active');
  if (opts.matchStatus) {
    where.push('match_status = ?');
    vals.push(opts.matchStatus);
  }
  if (opts.reviewed !== undefined) {
    where.push('reviewed = ?');
    vals.push(opts.reviewed ? 1 : 0);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM reconciliations ${w}`)
    .bind(...vals)
    .first<{ n: number }>();
  const r = await db
    .prepare(
      `SELECT * FROM reconciliations ${w}
       ORDER BY match_score DESC, created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...vals, limit, offset)
    .all<ReconciliationRow>();
  return { items: r.results, total: countRow?.n ?? 0 };
}

export async function getReconciliationById(
  db: D1Database,
  id: string
): Promise<ReconciliationRow | null> {
  return db
    .prepare(`SELECT * FROM reconciliations WHERE id = ?`)
    .bind(id)
    .first<ReconciliationRow>();
}

export async function updateReconciliationReview(
  db: D1Database,
  id: string,
  input: { reviewed: boolean; reviewedBy: string | null; notes?: string | null }
): Promise<void> {
  await db
    .prepare(
      `UPDATE reconciliations
       SET reviewed = ?, reviewed_at = ?, reviewed_by = ?, notes = COALESCE(?, notes)
       WHERE id = ?`
    )
    .bind(input.reviewed ? 1 : 0, jstNow(), input.reviewedBy, input.notes ?? null, id)
    .run();
}

export class ManualMatchValidationError extends Error {
  constructor(public reason: string) {
    super(`manual match validation failed: ${reason}`);
    this.name = 'ManualMatchValidationError';
  }
}

/**
 * 手動マッチング。Codex Phase 2 review HIGH #9 反映:
 *   - 対象行が active か検証
 *   - 候補（dispatch / client）が同 period かつ active か検証
 *   - 候補が他の active matched に既に使われていないか検証
 *   - 元行が dispatch_only/client_only と整合するか検証
 */
export async function manualMatchReconciliation(
  db: D1Database,
  id: string,
  input: { dispatchId?: string; clientRecordId?: string; reviewedBy: string }
): Promise<void> {
  const before = await getReconciliationById(db, id);
  if (!before) throw new ManualMatchValidationError('reconciliation not found');
  if (before.status !== 'active') {
    throw new ManualMatchValidationError(`reconciliation is not active (${before.status})`);
  }
  const nextDispatch = input.dispatchId ?? before.dispatch_id;
  const nextClient = input.clientRecordId ?? before.client_record_id;

  // dispatch_only から client を補完するパターン: client_record の存在 + 同 period 確認
  if (input.clientRecordId) {
    if (before.match_status !== 'dispatch_only') {
      throw new ManualMatchValidationError(
        `cannot attach client_record to ${before.match_status}`
      );
    }
    const cr = await db
      .prepare(`SELECT id, period FROM client_records WHERE id = ?`)
      .bind(input.clientRecordId)
      .first<{ id: string; period: string }>();
    if (!cr) {
      throw new ManualMatchValidationError(`client_record not found: ${input.clientRecordId}`);
    }
    if (cr.period !== before.period) {
      throw new ManualMatchValidationError(
        `period mismatch: client=${cr.period}, recon=${before.period}`
      );
    }
    // 既に matched で使われていないか
    const used = await db
      .prepare(
        `SELECT id FROM reconciliations
         WHERE client_record_id = ? AND status = 'active' AND match_status = 'matched' AND id != ?
         LIMIT 1`
      )
      .bind(input.clientRecordId, id)
      .first<{ id: string }>();
    if (used) {
      throw new ManualMatchValidationError(
        `client_record already matched in reconciliation ${used.id}`
      );
    }
  }

  // client_only から dispatch を補完するパターン
  if (input.dispatchId) {
    if (before.match_status !== 'client_only') {
      throw new ManualMatchValidationError(
        `cannot attach dispatch_record to ${before.match_status}`
      );
    }
    const dr = await db
      .prepare(`SELECT id, work_date FROM dispatch_records WHERE id = ?`)
      .bind(input.dispatchId)
      .first<{ id: string; work_date: string }>();
    if (!dr) {
      throw new ManualMatchValidationError(`dispatch_record not found: ${input.dispatchId}`);
    }
    // work_date が period に含まれるか（YYYY-MM プレフィックス）
    if (!dr.work_date.startsWith(before.period)) {
      throw new ManualMatchValidationError(
        `period mismatch: dispatch.work_date=${dr.work_date}, recon.period=${before.period}`
      );
    }
    const used = await db
      .prepare(
        `SELECT id FROM reconciliations
         WHERE dispatch_id = ? AND status = 'active' AND match_status = 'matched' AND id != ?
         LIMIT 1`
      )
      .bind(input.dispatchId, id)
      .first<{ id: string }>();
    if (used) {
      throw new ManualMatchValidationError(
        `dispatch_record already matched in reconciliation ${used.id}`
      );
    }
  }

  await db
    .prepare(
      `UPDATE reconciliations
       SET dispatch_id = ?, client_record_id = ?, match_status = 'matched',
           match_method = 'manual', match_score = 1.0,
           reviewed = 1, reviewed_at = ?, reviewed_by = ?
       WHERE id = ?`
    )
    .bind(nextDispatch, nextClient, jstNow(), input.reviewedBy, id)
    .run();
}

// =============================================================================
// reconciliation_jobs
// =============================================================================

export class ActiveReconciliationJobExistsError extends Error {
  constructor(public period: string) {
    super(`active reconciliation job already exists for ${period}`);
    this.name = 'ActiveReconciliationJobExistsError';
  }
}

export async function createReconciliationJob(
  db: D1Database,
  input: { period: string; requestedBy: string }
): Promise<ReconciliationJobRow> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO reconciliation_jobs (id, period, status, requested_by)
         VALUES (?, ?, 'queued', ?)`
      )
      .bind(id, input.period, input.requestedBy)
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ActiveReconciliationJobExistsError(input.period);
    }
    throw e;
  }
  return (await getReconciliationJobById(db, id))!;
}

export async function getReconciliationJobById(
  db: D1Database,
  id: string
): Promise<ReconciliationJobRow | null> {
  return db
    .prepare(`SELECT * FROM reconciliation_jobs WHERE id = ?`)
    .bind(id)
    .first<ReconciliationJobRow>();
}

export async function tryMarkReconciliationJobRunning(
  db: D1Database,
  id: string
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE reconciliation_jobs SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .bind(jstNow(), id)
    .run();
  return ((r.meta as { changes?: number }).changes ?? 0) === 1;
}

export async function markReconciliationJobCompleted(
  db: D1Database,
  id: string,
  counts: {
    dispatchCount: number;
    clientCount: number;
    matchedCount: number;
    clientOnlyCount: number;
    dispatchOnlyCount: number;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE reconciliation_jobs SET status = 'completed', progress = 100,
         dispatch_count = ?, client_count = ?, matched_count = ?,
         client_only_count = ?, dispatch_only_count = ?, completed_at = ?
       WHERE id = ?`
    )
    .bind(
      counts.dispatchCount,
      counts.clientCount,
      counts.matchedCount,
      counts.clientOnlyCount,
      counts.dispatchOnlyCount,
      jstNow(),
      id
    )
    .run();
}

export async function markReconciliationJobFailed(
  db: D1Database,
  id: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE reconciliation_jobs SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ?`
    )
    .bind(error.slice(0, 2000), jstNow(), id)
    .run();
}

export async function getQueuedReconciliationJobs(
  db: D1Database,
  limit = 3
): Promise<ReconciliationJobRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM reconciliation_jobs WHERE status = 'queued'
       ORDER BY requested_at ASC LIMIT ?`
    )
    .bind(limit)
    .all<ReconciliationJobRow>();
  return r.results;
}

/** 古い running ジョブを failed に倒す（Phase 1 と同じ仕組み） */
export async function recoverStuckReconciliationJobs(
  db: D1Database,
  staleThresholdMinutes = 30
): Promise<number> {
  const cutoffMs = Date.now() - staleThresholdMinutes * 60_000;
  const r = await db
    .prepare(`SELECT id, started_at FROM reconciliation_jobs WHERE status = 'running'`)
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
        `UPDATE reconciliation_jobs SET status = 'failed',
           error_message = COALESCE(error_message, 'recovered from stuck running'),
           completed_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .bind(now, id)
  );
  await db.batch(stmts);
  return stuck.length;
}

/** 月次照合の対象データ取得用ヘルパ。dispatch_records は work_date が period に含まれるもの */
export async function getDispatchesForPeriod(
  db: D1Database,
  period: string
): Promise<
  Array<{
    id: string;
    driver_id: string;
    work_date: string;
    task_name: string | null;
    start_time: string | null;
    end_time: string | null;
  }>
> {
  const r = await db
    .prepare(
      `SELECT id, driver_id, work_date, task_name, start_time, end_time
       FROM dispatch_records
       WHERE work_date LIKE ?
       ORDER BY work_date, driver_id, task_number`
    )
    .bind(`${period}%`)
    .all<{
      id: string;
      driver_id: string;
      work_date: string;
      task_name: string | null;
      start_time: string | null;
      end_time: string | null;
    }>();
  return r.results;
}

export async function getClientRecordsForReconcilePeriod(
  db: D1Database,
  period: string
): Promise<
  Array<{
    id: string;
    driver_id: string | null;
    period: string;
    work_day: number;
    task_name: string | null;
    start_time: string | null;
    end_time: string | null;
    fare: number | null;
    advance_payment: number;
  }>
> {
  const r = await db
    .prepare(
      `SELECT cr.id, cr.driver_id, cr.period, cr.work_day, cr.task_name,
              cr.start_time, cr.end_time, cr.fare, cr.advance_payment
       FROM client_records cr
       INNER JOIN import_batches b ON b.id = cr.import_batch_id
       WHERE cr.period = ? AND b.status = 'confirmed'
       ORDER BY cr.work_day, cr.driver_id`
    )
    .bind(period)
    .all<{
      id: string;
      driver_id: string | null;
      period: string;
      work_day: number;
      task_name: string | null;
      start_time: string | null;
      end_time: string | null;
      fare: number | null;
      advance_payment: number;
    }>();
  return r.results;
}
