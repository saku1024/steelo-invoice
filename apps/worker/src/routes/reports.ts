// STEELO Phase 3 F10: 月次 PDF レポート REST API
//
// Codex Phase 3 round 1 HIGH #14 反映:
//   ダウンロードは presigned URL ではなく Bearer 必須の authenticated proxy
//   (Phase 1 payment-summary と同方式)。R2 から bytes を取得して直接ストリーミング。
import { Hono } from 'hono';
import {
  createReportJob,
  getReportJobById,
  listReportJobs,
  ActiveReportJobExistsError,
  ReportSourceMissingError,
  markReportJobFailed,
  type ReportType,
} from '@line-crm/db';
import { runReportJob } from '../services/report-job.js';
import { RECONCILIATION_TEMPLATE_VERSION } from '../services/pdf-templates/reconciliation-report.js';
import { safeAudit } from '../services/audit.js';
import { asPeriodStr } from '../services/validation.js';
import type { Env } from '../index.js';

const ALLOWED_TYPES: ReportType[] = ['reconciliation', 'client_summary', 'payment_summary'];

const route = new Hono<Env>();

/**
 * POST /api/reports/jobs
 * Body: { period: "YYYY-MM", reportType: "reconciliation" | "client_summary" | "payment_summary" }
 * Response: 202 + { jobId } / 409 active 重複 / 422 source 不在 / 400 bad input
 */
route.post('/api/reports/jobs', async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const period = asPeriodStr(body.period);
    if (!period) {
      return c.json({ success: false, error: 'period (YYYY-MM) required' }, 400);
    }
    const reportType = body.reportType;
    if (typeof reportType !== 'string' || !ALLOWED_TYPES.includes(reportType as ReportType)) {
      return c.json(
        { success: false, error: `reportType must be one of ${ALLOWED_TYPES.join(', ')}` },
        400,
      );
    }

    const staff = c.get('staff');
    let job;
    try {
      job = await createReportJob(c.env.DB, {
        period,
        reportType: reportType as ReportType,
        templateVersion: RECONCILIATION_TEMPLATE_VERSION, // 全種共通 (現状)
        requestedBy: staff?.id ?? 'unknown',
      });
    } catch (e) {
      if (e instanceof ActiveReportJobExistsError) {
        return c.json(
          { success: false, error: `active job exists for ${e.period}:${e.reportType}` },
          409,
        );
      }
      if (e instanceof ReportSourceMissingError) {
        return c.json(
          {
            success: false,
            error: `required source not found for ${e.reportType} in ${e.period}`,
          },
          422,
        );
      }
      throw e;
    }

    // Queues 利用可能なら send、そうでなければ waitUntil で即実行
    const queue = c.env.REPORT_QUEUE;
    try {
      if (queue) {
        await queue.send({ jobId: job.id });
      } else {
        c.executionCtx.waitUntil(runReportJob(c.env, { jobId: job.id }));
      }
    } catch (e) {
      // enqueue 失敗時は job を failed に倒して active_report_key を解放
      // (Codex Phase 3 round 1 HIGH #5 反映)
      await markReportJobFailed(c.env.DB, job.id, `enqueue failed: ${String(e)}`);
      throw e;
    }

    await safeAudit(c.env.DB, c, {
      action: 'report_generated',
      resourceType: 'report_job',
      resourceId: job.id,
      payload: { period, report_type: reportType, status: 'queued' },
    });

    return c.json(
      {
        success: true,
        data: {
          jobId: job.id,
          statusUrl: `/api/reports/jobs/${job.id}`,
        },
      },
      202,
    );
  } catch (e) {
    console.error('POST /api/reports/jobs error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/reports/jobs/:id
 * ジョブ状態 + メタデータを返す (R2 key 自体は API レスポンスに含めない)。
 */
route.get('/api/reports/jobs/:id', async (c) => {
  try {
    const job = await getReportJobById(c.env.DB, c.req.param('id'));
    if (!job) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: job.id,
        period: job.period,
        reportType: job.report_type,
        status: job.status,
        templateVersion: job.template_version,
        byteSize: job.byte_size,
        pageCount: job.page_count,
        sourceImportBatchId: job.source_import_batch_id,
        sourceReconciliationJobId: job.source_reconciliation_job_id,
        errorMessage: job.error_message,
        requestedBy: job.requested_by,
        requestedAt: job.requested_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        downloadUrl:
          job.status === 'completed' && job.r2_key
            ? `/api/reports/jobs/${job.id}/download`
            : null,
      },
    });
  } catch (e) {
    console.error('GET /api/reports/jobs/:id error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/reports/jobs
 * 一覧 (period / status でフィルタ)。
 */
route.get('/api/reports/jobs', async (c) => {
  try {
    const period = c.req.query('period');
    const status = c.req.query('status') as
      | 'queued'
      | 'running'
      | 'completed'
      | 'failed'
      | undefined;
    const rows = await listReportJobs(c.env.DB, {
      period: period ? asPeriodStr(period) ?? undefined : undefined,
      status,
      limit: 50,
    });
    return c.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          id: r.id,
          period: r.period,
          reportType: r.report_type,
          status: r.status,
          byteSize: r.byte_size,
          pageCount: r.page_count,
          requestedAt: r.requested_at,
          completedAt: r.completed_at,
        })),
        total: rows.length,
      },
    });
  } catch (e) {
    console.error('GET /api/reports/jobs error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/reports/jobs/:id/download
 * Bearer 必須 proxy download (Codex Phase 3 round 1 HIGH #14)。
 * R2 から bytes を取得して Content-Disposition で直接ストリーミング。
 * presigned URL は使わない (Phase 1 payment-summary と方式統一)。
 */
route.get('/api/reports/jobs/:id/download', async (c) => {
  try {
    const job = await getReportJobById(c.env.DB, c.req.param('id'));
    if (!job) return c.json({ success: false, error: 'Not found' }, 404);
    if (job.status !== 'completed' || !job.r2_key) {
      return c.json(
        { success: false, error: `report not ready (status=${job.status})` },
        400,
      );
    }
    if (!c.env.STEELO_FILES) {
      return c.json({ success: false, error: 'storage not configured' }, 500);
    }
    const obj = await c.env.STEELO_FILES.get(job.r2_key);
    if (!obj) {
      return c.json({ success: false, error: 'pdf not found in storage' }, 410);
    }
    const filename = `steelo-${job.period}-${job.report_type}.pdf`;
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    console.error('GET /api/reports/jobs/:id/download error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default route;
