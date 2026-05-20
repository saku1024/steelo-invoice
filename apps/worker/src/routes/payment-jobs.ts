import { Hono } from 'hono';
import {
  createPaymentJob,
  getPaymentJobById,
  listDrivers,
  getConfirmedBatchByPeriod,
  ActiveJobAlreadyExistsError,
  type PaymentJobRow,
} from '@line-crm/db';
import type { PaymentJob } from '@line-crm/shared';
import { safeAudit } from '../services/audit.js';
import { runPaymentJob } from '../services/payment-batch-job.js';
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
    if (job.status !== 'completed' || !job.r2_zip_key) {
      return c.json({ success: false, error: 'job not completed' }, 409);
    }
    if (!c.env.STEELO_FILES) {
      return c.json({ success: false, error: 'storage not configured' }, 500);
    }
    const obj = await c.env.STEELO_FILES.get(job.r2_zip_key);
    if (!obj) {
      return c.json({ success: false, error: 'zip missing on storage' }, 410);
    }
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${job.period}_payment_summaries.zip"`,
      },
    });
  } catch (err) {
    console.error('GET /api/payment-summaries/jobs/:id/download error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default paymentJobs;
