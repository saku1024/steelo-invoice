// STEELO Phase 2 F4: 月次照合ジョブ。Queues consumer / Scheduled fallback から
// 1 ジョブを実行する。
import {
  commitReconciliationsAtomic,
  markReconciliationJobCompleted,
  markReconciliationJobFailed,
  tryMarkReconciliationJobRunning,
  getReconciliationJobById,
  getDispatchesForPeriod,
  getClientRecordsForReconcilePeriod,
  listAllBaselines,
} from '@line-crm/db';
import {
  buildBaselineMap,
  buildDispatchCountByDriverDate,
  type Baseline,
} from './anomaly-detector.js';
import { serializeWarnings } from './parse-warnings.js';
import { reconcile } from './reconciliation.js';
import { recordSystemAudit } from './audit.js';
import type { Env } from '../index.js';

export interface ReconciliationJobPayload {
  jobId: string;
}

export async function runReconciliationJob(
  env: Env['Bindings'],
  payload: ReconciliationJobPayload
): Promise<void> {
  const jobId = payload.jobId;
  const job = await getReconciliationJobById(env.DB, jobId);
  if (!job) {
    console.error(`[reconciliation-job] ${jobId} not found`);
    return;
  }
  if (job.status !== 'queued') {
    console.warn(`[reconciliation-job] ${jobId} status=${job.status}, skipping`);
    return;
  }
  const claimed = await tryMarkReconciliationJobRunning(env.DB, jobId);
  if (!claimed) {
    console.warn(`[reconciliation-job] ${jobId} already claimed`);
    return;
  }

  try {
    const dispatches = await getDispatchesForPeriod(env.DB, job.period);
    const clientRecords = await getClientRecordsForReconcilePeriod(env.DB, job.period);

    // Phase 3 (F8) 反映:
    //   reconcile() に anomalyContext を渡して構造化 warning を生成する。
    //   - baselines: anomaly_baselines テーブルから現行世代を取得
    //   - dispatchCountByDriverDate: getDispatchesForPeriod() の全件を集計
    //     (Codex Phase 3 review HIGH #10 / MEDIUM #8 反映)
    const baselineRows = await listAllBaselines(env.DB);
    const baselines: Baseline[] = baselineRows.map((b) => ({
      driverId: b.driver_id,
      taskName: b.task_name,
      medianFare: b.median_fare,
      sdFare: b.sd_fare,
      sampleSize: b.sample_size,
      baselineScope: b.baseline_scope === 'driver_fallback'
        ? 'driver_fallback'
        : 'task',
    }));
    const anomalyContext = {
      baselines: buildBaselineMap(baselines),
      dispatchCountByDriverDate: buildDispatchCountByDriverDate(dispatches),
    };

    const { rows, summary } = reconcile({
      dispatches,
      clientRecords,
      anomalyContext,
    });

    // Codex Phase 2 review CRITICAL #3 反映:
    // 旧 active を archived へ → 新 active を bulk INSERT を、commitReconciliationsAtomic
    // で D1 batch 単位で原子的に実行する。
    // Phase 3: warnings は serializeWarnings() で JSON 文字列に変換してから渡す。
    const inputs = rows.map((r) => ({
      period: job.period,
      reconciliationJobId: jobId,
      dispatchId: r.dispatchId,
      clientRecordId: r.clientRecordId,
      matchStatus: r.matchStatus,
      matchMethod: r.matchMethod,
      matchScore: r.matchScore,
      warningsJson: serializeWarnings(r.warnings),
    }));
    await commitReconciliationsAtomic(env.DB, job.period, inputs);

    await markReconciliationJobCompleted(env.DB, jobId, {
      dispatchCount: dispatches.length,
      clientCount: clientRecords.length,
      matchedCount: summary.matched,
      clientOnlyCount: summary.clientOnly,
      dispatchOnlyCount: summary.dispatchOnly,
    });

    try {
      await recordSystemAudit(env.DB, {
        action: 'reconciliation_run',
        resourceType: 'reconciliation_job',
        resourceId: jobId,
        payload: { period: job.period, ...summary },
      });
    } catch (e) {
      console.error('[reconciliation-job] audit failed:', e);
    }
  } catch (e) {
    console.error(`[reconciliation-job] ${jobId} failed:`, e);
    await markReconciliationJobFailed(env.DB, jobId, String(e));
  }
}
