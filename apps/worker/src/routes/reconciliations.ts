import { Hono } from 'hono';
import {
  createReconciliationJob,
  getReconciliationJobById,
  listReconciliations,
  getReconciliationById,
  updateReconciliationReview,
  manualMatchReconciliation,
  ActiveReconciliationJobExistsError,
  ManualMatchValidationError,
  type ReconciliationRow,
  type ReconciliationJobRow,
} from '@line-crm/db';
import type {
  Reconciliation,
  ReconciliationJob,
  MatchStatus,
} from '@line-crm/shared';
import { safeAudit } from '../services/audit.js';
import { runReconciliationJob } from '../services/reconciliation-job.js';
import { asPeriodStr, clampLimit, clampOffset } from '../services/validation.js';
import { parseWarnings } from '../services/parse-warnings.js';
import type { Env } from '../index.js';

const reconciliations = new Hono<Env>();

// Phase 3 (F8) 反映:
//   API レスポンスは常に StructuredWarning[] を返す。parseWarnings() で
//   Phase 2 文字列配列と Phase 3 構造化配列の両方を正規化する (Codex round 1 CRITICAL #2)。
function serialize(r: ReconciliationRow): Reconciliation {
  return {
    id: r.id,
    period: r.period,
    reconciliationJobId: r.reconciliation_job_id,
    dispatchId: r.dispatch_id,
    clientRecordId: r.client_record_id,
    matchStatus: r.match_status as MatchStatus,
    matchMethod: r.match_method as Reconciliation['matchMethod'],
    matchScore: r.match_score,
    warnings: parseWarnings(r.warnings),
    status: r.status as Reconciliation['status'],
    reviewed: Boolean(r.reviewed),
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

function serializeJob(r: ReconciliationJobRow): ReconciliationJob {
  return {
    id: r.id,
    period: r.period,
    status: r.status as ReconciliationJob['status'],
    progress: r.progress,
    dispatchCount: r.dispatch_count,
    clientCount: r.client_count,
    matchedCount: r.matched_count,
    clientOnlyCount: r.client_only_count,
    dispatchOnlyCount: r.dispatch_only_count,
    errorMessage: r.error_message,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

// =============================================================================
// 一覧
// =============================================================================

reconciliations.get('/api/reconciliations', async (c) => {
  try {
    const period = asPeriodStr(c.req.query('period'));
    if (!period) return c.json({ success: false, error: 'period (YYYY-MM) required' }, 400);
    const matchStatus = c.req.query('match_status') as MatchStatus | undefined;
    if (
      matchStatus &&
      !['matched', 'client_only', 'dispatch_only'].includes(matchStatus)
    ) {
      return c.json({ success: false, error: 'invalid match_status' }, 400);
    }
    const reviewedRaw = c.req.query('reviewed');
    const reviewed =
      reviewedRaw === 'true' ? true : reviewedRaw === 'false' ? false : undefined;
    const result = await listReconciliations(c.env.DB, {
      period,
      matchStatus,
      reviewed,
      limit: clampLimit(c.req.query('limit'), 100, 500),
      offset: clampOffset(c.req.query('offset')),
    });
    return c.json({
      success: true,
      data: { items: result.items.map(serialize), total: result.total },
    });
  } catch (err) {
    console.error('GET /api/reconciliations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reconciliations.get('/api/reconciliations/:id', async (c) => {
  try {
    const row = await getReconciliationById(c.env.DB, c.req.param('id'));
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error('GET /api/reconciliations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// レビュー
// =============================================================================

reconciliations.post('/api/reconciliations/:id/review', async (c) => {
  try {
    const id = c.req.param('id');
    const body = (await c.req.json()) as Record<string, unknown>;
    const reviewed = body.reviewed === true;
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;
    const before = await getReconciliationById(c.env.DB, id);
    if (!before) return c.json({ success: false, error: 'Not found' }, 404);
    const staff = c.get('staff');
    await updateReconciliationReview(c.env.DB, id, {
      reviewed,
      reviewedBy: staff?.id ?? null,
      notes,
    });
    await safeAudit(c.env.DB, c, {
      action: 'reconciliation_review',
      resourceType: 'reconciliation',
      resourceId: id,
      payload: { reviewed, notes },
    });
    const after = await getReconciliationById(c.env.DB, id);
    return c.json({ success: true, data: serialize(after!) });
  } catch (err) {
    console.error('POST /api/reconciliations/:id/review error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reconciliations.post('/api/reconciliations/:id/manual-match', async (c) => {
  try {
    const id = c.req.param('id');
    const body = (await c.req.json()) as Record<string, unknown>;
    const dispatchId =
      typeof body.dispatchId === 'string' && body.dispatchId.trim() !== ''
        ? body.dispatchId
        : undefined;
    const clientRecordId =
      typeof body.clientRecordId === 'string' && body.clientRecordId.trim() !== ''
        ? body.clientRecordId
        : undefined;
    if (!dispatchId && !clientRecordId) {
      return c.json(
        { success: false, error: 'dispatchId or clientRecordId is required' },
        400
      );
    }
    const staff = c.get('staff');
    try {
      await manualMatchReconciliation(c.env.DB, id, {
        dispatchId,
        clientRecordId,
        reviewedBy: staff?.id ?? 'unknown',
      });
    } catch (e) {
      if (e instanceof ManualMatchValidationError) {
        return c.json({ success: false, error: e.message, reason: e.reason }, 400);
      }
      throw e;
    }
    await safeAudit(c.env.DB, c, {
      action: 'dispatch_manual_match',
      resourceType: 'reconciliation',
      resourceId: id,
      payload: { dispatchId, clientRecordId },
    });
    const after = await getReconciliationById(c.env.DB, id);
    return c.json({ success: true, data: serialize(after!) });
  } catch (err) {
    console.error('POST /api/reconciliations/:id/manual-match error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// ジョブ
// =============================================================================

reconciliations.post('/api/reconciliations/jobs', async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const period = asPeriodStr(body.period);
    if (!period) return c.json({ success: false, error: 'period (YYYY-MM) required' }, 400);
    const staff = c.get('staff');
    let job;
    try {
      job = await createReconciliationJob(c.env.DB, {
        period,
        requestedBy: staff?.id ?? 'unknown',
      });
    } catch (e) {
      if (e instanceof ActiveReconciliationJobExistsError) {
        return c.json(
          { success: false, error: `active job exists for ${e.period}` },
          409
        );
      }
      throw e;
    }
    // Codex Phase 2 review HIGH #5 反映:
    // queue.send 失敗時に job を failed に倒して active_period_key UNIQUE を解放する
    const queue = (c.env as { RECONCILIATION_QUEUE?: Queue }).RECONCILIATION_QUEUE;
    try {
      if (queue) {
        await queue.send({ jobId: job.id });
      } else {
        c.executionCtx.waitUntil(runReconciliationJob(c.env, { jobId: job.id }));
      }
    } catch (e) {
      // enqueue 失敗時は job を failed に
      const { markReconciliationJobFailed } = await import('@line-crm/db');
      await markReconciliationJobFailed(c.env.DB, job.id, `enqueue failed: ${String(e)}`);
      throw e;
    }
    await safeAudit(c.env.DB, c, {
      action: 'reconciliation_run',
      resourceType: 'reconciliation_job',
      resourceId: job.id,
      payload: { period },
    });
    return c.json(
      {
        success: true,
        data: {
          jobId: job.id,
          statusUrl: `/api/reconciliations/jobs/${job.id}`,
        },
      },
      202
    );
  } catch (err) {
    console.error('POST /api/reconciliations/jobs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reconciliations.get('/api/reconciliations/jobs/:id', async (c) => {
  try {
    const row = await getReconciliationJobById(c.env.DB, c.req.param('id'));
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeJob(row) });
  } catch (err) {
    console.error('GET /api/reconciliations/jobs/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default reconciliations;
