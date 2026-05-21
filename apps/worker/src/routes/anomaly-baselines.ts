// STEELO Phase 3 F8: anomaly_baselines の REST API
//
// 月初 cron で自動 recompute されるが、設定変更時や手動再計算用にエンドポイントも公開。
import { Hono } from 'hono';
import { listAllBaselines } from '@line-crm/db';
import {
  runAnomalyBaselineJob,
  computeSourceWindow,
} from '../services/anomaly-baseline-job.js';
import { safeAudit } from '../services/audit.js';
import { asPeriodStr } from '../services/validation.js';
import type { Env } from '../index.js';

const anomalyBaselines = new Hono<Env>();

/**
 * GET /api/anomaly-baselines
 * 現在の baseline 一覧を返す (運用確認用)。
 */
anomalyBaselines.get('/api/anomaly-baselines', async (c) => {
  try {
    const rows = await listAllBaselines(c.env.DB);
    return c.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          id: r.id,
          driverId: r.driver_id,
          taskName: r.task_name,
          medianFare: r.median_fare,
          sdFare: r.sd_fare,
          sampleSize: r.sample_size,
          baselineScope: r.baseline_scope,
          periodFrom: r.period_from,
          periodTo: r.period_to,
          computedAt: r.computed_at,
        })),
        total: rows.length,
      },
    });
  } catch (err) {
    console.error('GET /api/anomaly-baselines error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/anomaly-baselines/recompute?period=YYYY-MM
 * 対象 period の直前 3 完了月から baseline を recompute する。
 * cron `0 0 1 * *` で月初に自動実行されるが、手動 trigger 用にも公開。
 */
anomalyBaselines.post('/api/anomaly-baselines/recompute', async (c) => {
  try {
    const period = asPeriodStr(c.req.query('period'));
    if (!period) {
      return c.json(
        { success: false, error: 'period (YYYY-MM) required' },
        400,
      );
    }
    const window = computeSourceWindow(period);
    const result = await runAnomalyBaselineJob(c.env.DB, { period });
    await safeAudit(c.env.DB, c, {
      action: 'anomaly_baseline_recompute',
      resourceType: 'anomaly_baselines',
      resourceId: `${window.periodFrom}~${window.periodTo}`,
      payload: {
        period,
        ...result,
      },
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/anomaly-baselines/recompute error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default anomalyBaselines;
