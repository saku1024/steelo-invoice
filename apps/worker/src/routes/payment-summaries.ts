import { Hono, type Context } from 'hono';
import {
  getDriverById,
  getConfirmedBatchByPeriod,
  getDriverDeduction,
  listClientRecordsByDriverPeriod,
  upsertDriverPaymentSummary,
  insertSummaryLines,
  listDriverPaymentSummariesByPeriod,
  getDriverPaymentSummaryById,
  listSummaryLines,
  type DriverPaymentSummaryRow,
} from '@line-crm/db';
import type { PaymentResult } from '@line-crm/shared';
import type { DriverPaymentSummary } from '@line-crm/shared';
import { calculatePayment } from '../services/payment-calculator.js';
import { buildDriverExcel, makeFileName } from '../services/excel-export.js';
import { safeAudit } from '../services/audit.js';
import type { Env } from '../index.js';

const paymentSummaries = new Hono<Env>();

function serialize(r: DriverPaymentSummaryRow): DriverPaymentSummary {
  return {
    id: r.id,
    driverId: r.driver_id,
    period: r.period,
    importBatchId: r.import_batch_id,
    paymentJobId: r.payment_job_id,
    driverNameSnapshot: r.driver_name_snapshot,
    hasInvoiceSnapshot: Boolean(r.has_invoice_snapshot),
    commissionRateSnapshot: r.commission_rate_snapshot,
    taxRateSnapshot: r.tax_rate_snapshot,
    roundingRule: 'per_line_round',
    totalFareBeforeTax: r.total_fare_before_tax,
    totalFareWithTax: r.total_fare_with_tax,
    totalAdvance: r.total_advance,
    vehicleCost: r.vehicle_cost,
    processingFee: r.processing_fee,
    prepayment: r.prepayment,
    finalAmount: r.final_amount,
    r2XlsxKey: r.r2_xlsx_key,
    generatedAt: r.generated_at,
  };
}

paymentSummaries.get('/api/payment-summaries', async (c) => {
  try {
    const period = c.req.query('period');
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return c.json({ success: false, error: 'period (YYYY-MM) required' }, 400);
    }
    const rows = await listDriverPaymentSummariesByPeriod(c.env.DB, period);
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    console.error('GET /api/payment-summaries error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// 個別生成 (同期 API) - Task 10.2
// =============================================================================

paymentSummaries.post('/api/payment-summaries/generate', async (c) => {
  try {
    const body = await c.req.json<{ driverId?: string; period?: string }>();
    if (typeof body.driverId !== 'string' || body.driverId.trim() === '') {
      return c.json({ success: false, error: 'driverId is required' }, 400);
    }
    if (typeof body.period !== 'string' || !/^\d{4}-\d{2}$/.test(body.period)) {
      return c.json({ success: false, error: 'period (YYYY-MM) required' }, 400);
    }
    const result = await generateForDriver(c.env, c, body.driverId, body.period);
    if ('error' in result) return c.json({ success: false, error: result.error }, result.status);

    const bytes = buildDriverExcel({
      driver: { name: result.driverName, hasInvoice: result.hasInvoice },
      period: body.period,
      records: result.recordsForExcel,
      result: result.payment,
    });
    const fileName = makeFileName(body.period, result.driverName);
    // R2 にも保存（再 DL 用）
    const r2Key = `generated/${body.period}/individual/${result.summaryId}.xlsx`;
    if (c.env.STEELO_FILES) {
      await c.env.STEELO_FILES.put(r2Key, bytes, {
        httpMetadata: {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        customMetadata: { period: body.period, driverId: body.driverId },
      });
      // r2_xlsx_key を更新
      await c.env.DB
        .prepare(`UPDATE driver_payment_summaries SET r2_xlsx_key = ? WHERE id = ?`)
        .bind(r2Key, result.summaryId)
        .run();
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    });
  } catch (err) {
    console.error('POST /api/payment-summaries/generate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// 再ダウンロード - Task 10.3
// R2 署名付きURL（S3 SigV4）は Workers 標準 API に無いため、Worker を経由した
// プロキシ DL で代替する（Bearer 必須）。design.md の「短命URL」要件と等価のセキュリティを
// 維持する（認証済みユーザーのみが DL 可能）。
// =============================================================================

paymentSummaries.get('/api/payment-summaries/:id/download', async (c) => {
  try {
    const summary = await getDriverPaymentSummaryById(c.env.DB, c.req.param('id'));
    if (!summary) return c.json({ success: false, error: 'Not found' }, 404);
    const fileName = makeFileName(summary.period, summary.driver_name_snapshot);

    // 1. R2 にキャッシュがあれば優先
    if (summary.r2_xlsx_key && c.env.STEELO_FILES) {
      const obj = await c.env.STEELO_FILES.get(summary.r2_xlsx_key);
      if (obj) {
        return new Response(obj.body, {
          status: 200,
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          },
        });
      }
    }

    // 2. R2 が消えていれば payment_summary_lines のスナップショットから再構築
    //    （Codex impl review HIGH #7 反映: 現在マスタで上書き再生成せず、当時の数値で再描画）
    const lines = await listSummaryLines(c.env.DB, summary.id);
    if (lines.length === 0 && summary.total_fare_with_tax === 0 && summary.total_advance === 0) {
      return c.json(
        { success: false, error: 'snapshot is empty; cannot reconstruct' },
        410
      );
    }
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
    const bytes = buildDriverExcel({
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
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'X-Reconstructed-From-Snapshot': '1',
      },
    });
  } catch (err) {
    console.error('GET /api/payment-summaries/:id/download error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// 内部ヘルパ: 1ドライバー分のスナップショット生成
// =============================================================================

async function generateForDriver(
  env: Env['Bindings'],
  c: Context<Env>,
  driverId: string,
  period: string
): Promise<
  | {
      summaryId: string;
      driverName: string;
      hasInvoice: boolean;
      payment: ReturnType<typeof calculatePayment>;
      recordsForExcel: Parameters<typeof buildDriverExcel>[0]['records'];
    }
  | { error: string; status: 400 | 404 }
> {
  const driver = await getDriverById(env.DB, driverId);
  if (!driver) return { error: 'driver not found', status: 404 };
  const batch = await getConfirmedBatchByPeriod(env.DB, period);
  if (!batch) return { error: 'no confirmed batch for period', status: 404 };
  const deduction = await getDriverDeduction(env.DB, driverId, period);
  const records = await listClientRecordsByDriverPeriod(env.DB, driverId, period);

  // 計算
  const payment = calculatePayment({
    driver: { hasInvoice: Boolean(driver.has_invoice) },
    rates: {
      commissionRate: batch.commission_rate,
      taxRate: batch.tax_rate,
    },
    deductions: {
      vehicleCost: deduction?.vehicle_cost ?? 0,
      processingFee: deduction?.processing_fee ?? 0,
      prepayment: deduction?.prepayment ?? 0,
    },
    records: records.map((r) => ({
      fare: r.fare,
      advancePayment: r.advance_payment,
    })),
  });

  // スナップショット UPSERT
  const summary = await upsertDriverPaymentSummary(env.DB, {
    driverId,
    period,
    importBatchId: batch.id,
    paymentJobId: null,
    driverNameSnapshot: driver.name,
    hasInvoiceSnapshot: Boolean(driver.has_invoice),
    commissionRateSnapshot: batch.commission_rate,
    taxRateSnapshot: batch.tax_rate,
    totalFareBeforeTax: payment.totalFareBeforeTax,
    totalFareWithTax: payment.totalFareWithTax,
    totalAdvance: payment.totalAdvance,
    vehicleCost: payment.vehicleCost,
    processingFee: payment.processingFee,
    prepayment: payment.prepayment,
    finalAmount: payment.finalAmount,
    r2XlsxKey: null,
  });
  await insertSummaryLines(
    env.DB,
    records.map((r, i) => {
      const fl = payment.fareLines[i];
      return {
        summaryId: summary.id,
        clientRecordId: r.id,
        workDay: r.work_day,
        taskName: r.task_name,
        fare: r.fare,
        fareAfterCommission: fl?.fareAfterCommission ?? null,
        fareWithTax: fl?.fareWithTax ?? null,
        advancePayment: r.advance_payment,
        excludedFromCalc: fl?.excludedFromCalc ?? false,
      };
    })
  );

  // 監査
  await safeAudit(env.DB, c, {
    action: 'payment_generate',
    resourceType: 'payment_summary',
    resourceId: summary.id,
    payload: { driverId, period, importBatchId: batch.id, finalAmount: payment.finalAmount },
  });

  return {
    summaryId: summary.id,
    driverName: driver.name,
    hasInvoice: Boolean(driver.has_invoice),
    payment,
    recordsForExcel: records.map((r) => ({
      workDay: r.work_day,
      dayOfWeek: r.day_of_week,
      taskName: r.task_name,
      pickupLocation: r.pickup_location,
      deliveryLocation: r.delivery_location,
      startTime: r.start_time,
      endTime: r.end_time,
      distanceKm: r.distance_km,
      advancePayment: r.advance_payment,
      fare: r.fare,
      notes: r.notes,
    })),
  };
}

export default paymentSummaries;
export { generateForDriver };
