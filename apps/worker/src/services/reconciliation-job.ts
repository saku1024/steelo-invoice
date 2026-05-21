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
} from '@line-crm/db';
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

    const { rows, summary } = reconcile({
      dispatches,
      clientRecords,
    });

    // Codex Phase 2 review CRITICAL #3 反映:
    // 旧 active を archived へ → 新 active を bulk INSERT を、commitReconciliationsAtomic
    // で D1 batch 単位で原子的に実行する。中途失敗時は active 全件を archived に
    // 倒して整合性を確保する補償処理込み。
    const inputs = rows.map((r) => ({
      period: job.period,
      reconciliationJobId: jobId,
      dispatchId: r.dispatchId,
      clientRecordId: r.clientRecordId,
      matchStatus: r.matchStatus,
      matchMethod: r.matchMethod,
      matchScore: r.matchScore,
      warnings: r.warnings,
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
