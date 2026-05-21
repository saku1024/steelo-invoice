// STEELO Phase 3 F8: anomaly_baselines のクエリヘルパ
//
// 設計:
//   - recompute は対象世代の全置換 (DELETE → INSERT を D1 batch 内で実行)
//   - SQLite UNIQUE は NULL を別値扱いするため、partial unique index で:
//     - task baseline: (driver_id, task_name) WHERE task_name IS NOT NULL
//     - driver_fallback: (driver_id) WHERE task_name IS NULL
import { jstNow } from './utils.js';

export interface AnomalyBaselineRow {
  id: string;
  driver_id: string;
  task_name: string | null;
  median_fare: number;
  sd_fare: number;
  sample_size: number;
  baseline_scope: string; // 'task' | 'driver_fallback'
  period_from: string;
  period_to: string;
  computed_at: string;
}

export interface BaselineInput {
  driverId: string;
  taskName: string | null;
  medianFare: number;
  sdFare: number;
  sampleSize: number;
  baselineScope: 'task' | 'driver_fallback';
}

/**
 * 対象 period の baseline を全置換する (Codex round 2 HIGH #4):
 *   1. period_from / period_to が一致する行を DELETE
 *   2. 新 baseline を INSERT
 * 両操作を D1 batch 内で原子的に実行。
 */
export async function replaceBaselinesAtomic(
  db: D1Database,
  input: {
    periodFrom: string;
    periodTo: string;
    rows: BaselineInput[];
  },
): Promise<{ deleted: number; inserted: number }> {
  // 削除対象件数を先に取得 (情報用、batch には DELETE のみ含める)
  const before = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM anomaly_baselines
       WHERE period_from = ? AND period_to = ?`,
    )
    .bind(input.periodFrom, input.periodTo)
    .first<{ n: number }>();
  const deleteCount = before?.n ?? 0;

  const now = jstNow();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM anomaly_baselines
         WHERE period_from = ? AND period_to = ?`,
      )
      .bind(input.periodFrom, input.periodTo),
    ...input.rows.map((r) =>
      db
        .prepare(
          `INSERT INTO anomaly_baselines
             (id, driver_id, task_name, median_fare, sd_fare, sample_size,
              baseline_scope, period_from, period_to, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          r.driverId,
          r.taskName,
          r.medianFare,
          r.sdFare,
          r.sampleSize,
          r.baselineScope,
          input.periodFrom,
          input.periodTo,
          now,
        ),
    ),
  ];
  await db.batch(stmts);
  return { deleted: deleteCount, inserted: input.rows.length };
}

/**
 * 全 baseline 行を取得 (現状運用では世代は 1 つだけ存在する想定)。
 * detector へ渡す Map のソースとして使う。
 */
export async function listAllBaselines(db: D1Database): Promise<AnomalyBaselineRow[]> {
  const r = await db
    .prepare(`SELECT * FROM anomaly_baselines ORDER BY driver_id, task_name`)
    .all<AnomalyBaselineRow>();
  return r.results;
}

export async function listBaselinesByDriver(
  db: D1Database,
  driverId: string,
): Promise<AnomalyBaselineRow[]> {
  const r = await db
    .prepare(`SELECT * FROM anomaly_baselines WHERE driver_id = ? ORDER BY task_name`)
    .bind(driverId)
    .all<AnomalyBaselineRow>();
  return r.results;
}

export async function clearBaselines(db: D1Database): Promise<number> {
  const r = await db.prepare(`DELETE FROM anomaly_baselines`).run();
  return (r.meta as { changes?: number }).changes ?? 0;
}
