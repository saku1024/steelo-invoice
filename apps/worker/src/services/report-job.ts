// STEELO Phase 3 F10: report-job consumer
//
// 1. getReportJobById で取得、tryMarkRunning で claim
// 2. source ID を使ってデータ取得 (生成元 snapshot)
// 3. pdf-generator でバイトを生成
// 4. R2 PUT
// 5. markReportJobCompleted (r2_key + byte_size + page_count)
//    失敗時 markFailed
import {
  getReportJobById,
  tryMarkReportJobRunning,
  markReportJobCompleted,
  markReportJobFailed,
  type ReportJobRow,
} from '@line-crm/db';
import {
  generateReconciliationReportPdf,
  ReportGenerationError,
} from './pdf-generator.js';
import { parseWarnings } from './parse-warnings.js';
import { recordSystemAudit } from './audit.js';
import type { Env } from '../index.js';
import type { ReconciliationRowForReport } from './pdf-templates/reconciliation-report.js';

export interface ReportJobPayload {
  jobId: string;
}

export async function runReportJob(
  env: Env['Bindings'],
  payload: ReportJobPayload,
): Promise<void> {
  const jobId = payload.jobId;
  const job = await getReportJobById(env.DB, jobId);
  if (!job) {
    console.error(`[report-job] ${jobId} not found`);
    return;
  }
  if (job.status !== 'queued') {
    console.warn(`[report-job] ${jobId} status=${job.status}, skipping`);
    return;
  }
  const claimed = await tryMarkReportJobRunning(env.DB, jobId);
  if (!claimed) {
    console.warn(`[report-job] ${jobId} already claimed`);
    return;
  }
  if (!env.STEELO_FILES) {
    await markReportJobFailed(env.DB, jobId, 'STEELO_FILES R2 bucket not bound');
    return;
  }

  try {
    if (job.report_type === 'reconciliation') {
      await runReconciliationReport(env, job);
    } else if (job.report_type === 'client_summary') {
      // P1 未実装 (PDF テンプレート別途) → fail with actionable error
      await markReportJobFailed(
        env.DB,
        jobId,
        'client_summary template not yet implemented (P1)',
      );
      return;
    } else {
      await markReportJobFailed(
        env.DB,
        jobId,
        `unknown report_type: ${job.report_type}`,
      );
      return;
    }
  } catch (e) {
    const msg =
      e instanceof ReportGenerationError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
        ? e.message
        : String(e);
    console.error(`[report-job] ${jobId} failed:`, msg);
    await markReportJobFailed(env.DB, jobId, msg);
  }
}

async function runReconciliationReport(
  env: Env['Bindings'],
  job: ReportJobRow,
): Promise<void> {
  if (!job.source_reconciliation_job_id) {
    await markReportJobFailed(
      env.DB,
      job.id,
      'reconciliation report requires source_reconciliation_job_id',
    );
    return;
  }
  if (!env.STEELO_FILES) {
    await markReportJobFailed(env.DB, job.id, 'STEELO_FILES R2 bucket not bound');
    return;
  }

  // source の reconciliation_jobs を取得して集計
  const sourceJob = await env.DB
    .prepare(`SELECT * FROM reconciliation_jobs WHERE id = ?`)
    .bind(job.source_reconciliation_job_id)
    .first<{
      period: string;
      matched_count: number;
      client_only_count: number;
      dispatch_only_count: number;
    }>();
  if (!sourceJob) {
    await markReportJobFailed(env.DB, job.id, 'source reconciliation_job not found');
    return;
  }

  // active な reconciliations 行を取得 (この source_job が紐付け先)
  const rowsResult = await env.DB
    .prepare(
      `SELECT r.match_status, r.match_method, r.match_score, r.warnings,
              d.work_date AS dispatch_work_date, d.task_name AS dispatch_task_name,
              cr.work_day AS client_work_day, cr.task_name AS client_task_name,
              cr.period AS client_period,
              dv.name AS driver_name
       FROM reconciliations r
       LEFT JOIN dispatch_records d ON d.id = r.dispatch_id
       LEFT JOIN client_records cr ON cr.id = r.client_record_id
       LEFT JOIN drivers dv ON dv.id = COALESCE(d.driver_id, cr.driver_id)
       WHERE r.reconciliation_job_id = ? AND r.status = 'active'
       ORDER BY r.match_status, r.match_score DESC`,
    )
    .bind(job.source_reconciliation_job_id)
    .all<{
      match_status: string;
      match_method: string;
      match_score: number;
      warnings: string | null;
      dispatch_work_date: string | null;
      dispatch_task_name: string | null;
      client_work_day: number | null;
      client_task_name: string | null;
      client_period: string | null;
      driver_name: string | null;
    }>();

  // 集計
  const warningCounts: Record<string, number> = {};
  const rows: ReconciliationRowForReport[] = rowsResult.results.map((r) => {
    const ws = parseWarnings(r.warnings);
    for (const w of ws) {
      warningCounts[w.type] = (warningCounts[w.type] ?? 0) + 1;
    }
    // client_period + work_day → work_date を作る (client_only 用)
    const clientWorkDate =
      r.client_period && r.client_work_day !== null
        ? `${r.client_period}-${String(r.client_work_day).padStart(2, '0')}`
        : null;
    return {
      matchStatus: r.match_status as 'matched' | 'client_only' | 'dispatch_only',
      matchMethod: r.match_method,
      matchScore: r.match_score,
      dispatchTaskName: r.dispatch_task_name,
      clientTaskName: r.client_task_name,
      workDate: r.dispatch_work_date ?? clientWorkDate,
      driverName: r.driver_name,
      warnings: ws,
    };
  });

  // 生成
  const result = await generateReconciliationReportPdf(env.STEELO_FILES, {
    period: sourceJob.period,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' JST',
    totals: {
      matched: sourceJob.matched_count,
      clientOnly: sourceJob.client_only_count,
      dispatchOnly: sourceJob.dispatch_only_count,
    },
    warningCounts,
    rows,
  });

  // R2 にアップロード
  const r2Key = `reports/${sourceJob.period}/${job.report_type}_${job.id}.pdf`;
  await env.STEELO_FILES.put(r2Key, result.bytes, {
    httpMetadata: {
      contentType: 'application/pdf',
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(`steelo-${sourceJob.period}-${job.report_type}.pdf`)}`,
    },
  });

  await markReportJobCompleted(env.DB, job.id, {
    r2Key,
    byteSize: result.byteSize,
    pageCount: result.pageCount,
  });

  // 監査
  try {
    await recordSystemAudit(env.DB, {
      action: 'report_generated',
      resourceType: 'report_job',
      resourceId: job.id,
      payload: {
        period: sourceJob.period,
        report_type: job.report_type,
        byte_size: result.byteSize,
        page_count: result.pageCount,
        template_version: result.templateVersion,
        warning_count_total: Object.values(warningCounts).reduce(
          (a, b) => a + b,
          0,
        ),
      },
    });
  } catch (e) {
    console.error('[report-job] audit failed:', e);
  }
}
