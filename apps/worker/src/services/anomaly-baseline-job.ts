// STEELO Phase 3 F8: anomaly_baselines 再計算ジョブ
//
// 月初 cron (`0 0 1 * *`) または手動 trigger で実行される。
//
// アルゴリズム (Codex Phase 3 round 1 HIGH #9 / round 2 HIGH #4):
//   1. period (照合対象月) の直前 3 完了月を source 範囲とする
//      例: period=2026-05 → source=2026-02 / 03 / 04
//   2. source 範囲内の confirmed import_batch 配下 client_records を取得
//   3. driver_id × task_name で集計し、優先順位で baseline を採用:
//      a. count(driver × task) >= 5 → baseline_scope='task'
//      b. それ未満で count(driver, 全 task) >= 3 → baseline_scope='driver_fallback'
//         (task_name = NULL の partial unique index 行で INSERT)
//      c. それ未満 → INSERT しない (baseline 無し扱い)
//   4. replaceBaselinesAtomic で対象 periodFrom/periodTo の旧行を DELETE → INSERT
import { replaceBaselinesAtomic, type BaselineInput } from '@line-crm/db';

const TASK_MIN_SAMPLES = 5;
const DRIVER_FALLBACK_MIN_SAMPLES = 3;

export interface BaselineJobInput {
  /** 照合対象月 "YYYY-MM" */
  period: string;
}

export interface BaselineJobResult {
  periodFrom: string;
  periodTo: string;
  taskBaselines: number;
  driverFallbackBaselines: number;
  skippedDrivers: number;
  durationMs: number;
}

/**
 * 月初 baseline 再計算のメインエントリ。
 * env.DB から client_records を直接読み、anomaly_baselines を全置換する。
 */
export async function runAnomalyBaselineJob(
  db: D1Database,
  input: BaselineJobInput,
): Promise<BaselineJobResult> {
  const start = Date.now();
  const { periodFrom, periodTo } = computeSourceWindow(input.period);

  // 3 ヶ月分の confirmed client_records を取得
  const rows = await db
    .prepare(
      `SELECT cr.driver_id, cr.task_name, cr.fare
       FROM client_records cr
       INNER JOIN import_batches ib ON ib.id = cr.import_batch_id
       WHERE cr.period >= ?
         AND cr.period <= ?
         AND cr.driver_id IS NOT NULL
         AND cr.fare IS NOT NULL
         AND ib.status = 'confirmed'`,
    )
    .bind(periodFrom, periodTo)
    .all<{ driver_id: string; task_name: string | null; fare: number }>();

  // driver_id × task_name で集計
  const taskGroup = new Map<string, number[]>(); // key: driver|task
  const driverGroup = new Map<string, number[]>(); // key: driver
  for (const r of rows.results) {
    const taskKey = `${r.driver_id}|${r.task_name ?? '__NULL__'}`;
    const driverKey = r.driver_id;
    const arrTask = taskGroup.get(taskKey);
    if (arrTask) arrTask.push(r.fare);
    else taskGroup.set(taskKey, [r.fare]);
    const arrDriver = driverGroup.get(driverKey);
    if (arrDriver) arrDriver.push(r.fare);
    else driverGroup.set(driverKey, [r.fare]);
  }

  // baseline 採用判定 (Codex round 1 HIGH #9 の優先順位)
  const baselines: BaselineInput[] = [];
  const driverHasTaskBaseline = new Set<string>();
  const seenDriversWithEnoughTaskCoverage = new Set<string>();

  // (a) task baseline: count >= TASK_MIN_SAMPLES
  // Codex full review HIGH #1 反映:
  //   task_name が NULL のデータは task baseline として作らない
  //   (driver_fallback と partial unique index 上で衝突するため)
  for (const [taskKey, fares] of taskGroup) {
    if (fares.length < TASK_MIN_SAMPLES) continue;
    const idx = taskKey.indexOf('|');
    const driverId = taskKey.slice(0, idx);
    const taskNameRaw = taskKey.slice(idx + 1);
    if (taskNameRaw === '__NULL__') continue; // NULL task は driver_fallback 側に集約
    baselines.push({
      driverId,
      taskName: taskNameRaw,
      medianFare: median(fares),
      sdFare: standardDeviation(fares),
      sampleSize: fares.length,
      baselineScope: 'task',
    });
    driverHasTaskBaseline.add(driverId);
    seenDriversWithEnoughTaskCoverage.add(driverId);
  }

  // (b) driver_fallback: task baseline が無く driver 全体 >= DRIVER_FALLBACK_MIN_SAMPLES
  // (task baseline が「ある driver」も driver_fallback を持っていてよい — task に当たらない
  // 業務名に対するフォールバック用)
  let driverFallbackCount = 0;
  for (const [driverId, fares] of driverGroup) {
    if (fares.length < DRIVER_FALLBACK_MIN_SAMPLES) continue;
    baselines.push({
      driverId,
      taskName: null,
      medianFare: median(fares),
      sdFare: standardDeviation(fares),
      sampleSize: fares.length,
      baselineScope: 'driver_fallback',
    });
    driverFallbackCount++;
  }

  // (c) skip された driver の数 (両 baseline 無し)
  const allDrivers = new Set(driverGroup.keys());
  const skippedDrivers = [...allDrivers].filter(
    (d) => !driverHasTaskBaseline.has(d) && (driverGroup.get(d)?.length ?? 0) < DRIVER_FALLBACK_MIN_SAMPLES,
  ).length;

  await replaceBaselinesAtomic(db, { periodFrom, periodTo, rows: baselines });

  return {
    periodFrom,
    periodTo,
    taskBaselines: baselines.filter((b) => b.baselineScope === 'task').length,
    driverFallbackBaselines: driverFallbackCount,
    skippedDrivers,
    durationMs: Date.now() - start,
  };
}

// =============================================================================
// helpers
// =============================================================================

/**
 * period=YYYY-MM の直前 3 完了月を返す。
 * 例: 2026-05 → periodFrom=2026-02, periodTo=2026-04
 */
export function computeSourceWindow(period: string): {
  periodFrom: string;
  periodTo: string;
} {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`invalid period: ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]); // 1-12
  // -3 month → from
  let fromY = y;
  let fromM = mo - 3;
  while (fromM < 1) {
    fromM += 12;
    fromY--;
  }
  // -1 month → to
  let toY = y;
  let toM = mo - 1;
  if (toM < 1) {
    toM += 12;
    toY--;
  }
  return {
    periodFrom: `${fromY}-${String(fromM).padStart(2, '0')}`,
    periodTo: `${toY}-${String(toM).padStart(2, '0')}`,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
