import { Hono } from 'hono';
import {
  createPaymentJob,
  getPaymentJobById,
  listDrivers,
  getConfirmedBatchByPeriod,
  listDriverPaymentSummariesByJobId,
  listSummaryLines,
  ActiveJobAlreadyExistsError,
  type PaymentJobRow,
} from '@line-crm/db';
import type { PaymentJob, PaymentResult } from '@line-crm/shared';
import { safeAudit } from '../services/audit.js';
import { runPaymentJob, rebuildZipFromSnapshot } from '../services/payment-batch-job.js';
import { buildDriverExcel, makeFileName } from '../services/excel-export.js';
import type { Env } from '../index.js';

const paymentJobs = new Hono<Env>();

function serialize(r: PaymentJobRow): PaymentJob {
  return {
    id: r.id,
    period: r.period,
    status: (r.status as 'queued' | 'running' | 'completed' | 'failed') ?? 'queued',
    progress: r.progress,
    totalDrivers: r.total_drivers,
    doneDrivers: r.done_drivers,
    r2ZipKey: r.r2_zip_key,
    errorMessage: r.error_message,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

paymentJobs.post('/api/payment-summaries/jobs', async (c) => {
  try {
    const body = await c.req.json<{ period?: string }>();
    if (!body.period || !/^\d{4}-\d{2}$/.test(body.period)) {
      return c.json({ success: false, error: 'period (YYYY-MM) required' }, 400);
    }
    const batch = await getConfirmedBatchByPeriod(c.env.DB, body.period);
    if (!batch) {
      return c.json({ success: false, error: 'no confirmed batch for period' }, 404);
    }
    const drivers = await listDrivers(c.env.DB, { activeOnly: true });
    const staff = c.get('staff');
    try {
      const job = await createPaymentJob(c.env.DB, {
        period: body.period,
        requestedBy: staff?.id ?? 'unknown',
        totalDrivers: drivers.length,
      });
      await safeAudit(c.env.DB, c, {
        action: 'payment_job_request',
        resourceType: 'payment_job',
        resourceId: job.id,
        payload: { period: body.period, totalDrivers: drivers.length },
      });

      // Queues バインディングがあれば enqueue、無ければ Scheduled fallback でも拾える
      if (c.env.PAYMENT_JOB_QUEUE) {
        await c.env.PAYMENT_JOB_QUEUE.send({ jobId: job.id });
      } else {
        // fallback: 即時 waitUntil で実行
        c.executionCtx.waitUntil(runPaymentJob(c.env, job.id));
      }
      return c.json(
        {
          success: true,
          data: {
            jobId: job.id,
            statusUrl: `/api/payment-summaries/jobs/${job.id}`,
          },
        },
        202
      );
    } catch (e) {
      if (e instanceof ActiveJobAlreadyExistsError) {
        return c.json(
          { success: false, error: `active job already exists for ${e.period}` },
          409
        );
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /api/payment-summaries/jobs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

paymentJobs.get('/api/payment-summaries/jobs/:id', async (c) => {
  try {
    const job = await getPaymentJobById(c.env.DB, c.req.param('id'));
    if (!job) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(job) });
  } catch (err) {
    console.error('GET /api/payment-summaries/jobs/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

paymentJobs.get('/api/payment-summaries/jobs/:id/download', async (c) => {
  try {
    const job = await getPaymentJobById(c.env.DB, c.req.param('id'));
    if (!job) return c.json({ success: false, error: 'Not found' }, 404);
    if (job.status !== 'completed') {
      return c.json({ success: false, error: 'job not completed' }, 409);
    }
    const filename = `${job.period}_payment_summaries.zip`;

    // 1. R2 にキャッシュがあれば優先
    if (job.r2_zip_key && c.env.STEELO_FILES) {
      const obj = await c.env.STEELO_FILES.get(job.r2_zip_key);
      if (obj) {
        return new Response(obj.body, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }
    }

    // 2. R2 が消えていれば payment_summary_lines のスナップショットから再構築
    //    （Codex verify HIGH #2 反映: 個別 xlsx と同じく、当時のスナップショットから ZIP を組み直す）
    const summaries = await listDriverPaymentSummariesByJobId(c.env.DB, job.id);
    if (summaries.length === 0) {
      return c.json({ success: false, error: 'no snapshot available to reconstruct' }, 410);
    }
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const summary of summaries) {
      const lines = await listSummaryLines(c.env.DB, summary.id);
      const result: PaymentResult = {
        fareLines: lines.map((l) => ({
          fareAfterCommission: l.fare_after_commission,
          fareWithTax: l.fare_with_tax,
          advance: l.advance_payment,
          excludedFromCalc: Boolean(l.excluded_from_calc),
        })),
        totalFareBeforeTax: summary.total_fare_before_tax,
        totalFareWithTax: summary.total_fare_with_tax,
        totalAdvance: summary.total_advance,
        vehicleCost: summary.vehicle_cost,
        processingFee: summary.processing_fee,
        prepayment: summary.prepayment,
        finalAmount: summary.final_amount,
      };
      const xlsx = buildDriverExcel({
        driver: {
          name: summary.driver_name_snapshot,
          hasInvoice: Boolean(summary.has_invoice_snapshot),
        },
        period: summary.period,
        records: lines.map((l) => ({
          workDay: l.work_day,
          dayOfWeek: null,
          taskName: l.task_name,
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: l.advance_payment,
          fare: l.fare,
          notes: null,
        })),
        result,
      });
      files.push({
        name: makeFileName(summary.period, summary.driver_name_snapshot),
        bytes: xlsx,
      });
    }
    const zipBytes = await rebuildZipFromSnapshot(files);
    return new Response(zipBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Reconstructed-From-Snapshot': '1',
      },
    });
  } catch (err) {
    console.error('GET /api/payment-summaries/jobs/:id/download error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default paymentJobs;
