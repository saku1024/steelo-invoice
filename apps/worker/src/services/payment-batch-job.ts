// STEELO Phase 1 F6-b: 一括支払明細生成ジョブのコンシューマ。
//
// Queues consumer または Scheduled() から呼ばれ、1ジョブを最後まで実行する:
//   1. payment_jobs を running に更新
//   2. 対象 period の active driver を全件取得し、それぞれ generateForDriver
//   3. 各 xlsx を R2 に PUT
//   4. 全件完了後に ZIP 化して R2 に PUT
//   5. payment_jobs を completed に更新（または failed）
import {
  listDrivers,
  getConfirmedBatchByPeriod,
  getDriverDeduction,
  listClientRecordsByDriverPeriod,
  upsertDriverPaymentSummary,
  insertSummaryLines,
  tryMarkPaymentJobRunning,
  updatePaymentJobProgress,
  markPaymentJobCompleted,
  markPaymentJobFailed,
  getPaymentJobById,
} from '@line-crm/db';
import { calculatePayment } from './payment-calculator.js';
import { buildDriverExcel, makeFileName } from './excel-export.js';
import { recordSystemAudit } from './audit.js';
import type { Env } from '../index.js';

interface JszipLike {
  file(name: string, data: Uint8Array): JszipLike;
  generateAsync(options: { type: 'uint8array' }): Promise<Uint8Array>;
}

/**
 * 軽量 ZIP 実装（STORE 方式、無圧縮）。Workers 環境で jszip の依存を増やさず
 * 単一ファイルから ZIP を組み立てるための最小実装。圧縮率は xlsx 自体が
 * 既に zip 圧縮されているため STORE で十分。
 */
function createZip(): JszipLike {
  const entries: { name: string; data: Uint8Array; crc: number; offset: number }[] = [];
  let cursor = 0;
  return {
    file(name: string, data: Uint8Array) {
      const crc = crc32(data);
      entries.push({ name, data, crc, offset: cursor });
      // local file header (30) + name + data
      cursor += 30 + new TextEncoder().encode(name).length + data.byteLength;
      return this;
    },
    async generateAsync() {
      // build local headers + bodies
      const parts: Uint8Array[] = [];
      const centralEntries: Uint8Array[] = [];
      let centralStart = 0;
      for (const e of entries) {
        const nameBytes = new TextEncoder().encode(e.name);
        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true); // signature
        dv.setUint16(4, 20, true); // version
        dv.setUint16(6, 0x0800, true); // UTF-8 flag
        dv.setUint16(8, 0, true); // STORE
        dv.setUint16(10, 0, true); // mtime
        dv.setUint16(12, 0, true); // mdate
        dv.setUint32(14, e.crc, true);
        dv.setUint32(18, e.data.byteLength, true);
        dv.setUint32(22, e.data.byteLength, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        local.set(nameBytes, 30);
        parts.push(local, e.data);
        centralStart += local.byteLength + e.data.byteLength;
      }
      let centralSize = 0;
      for (const e of entries) {
        const nameBytes = new TextEncoder().encode(e.name);
        const central = new Uint8Array(46 + nameBytes.length);
        const dv = new DataView(central.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, 0, true);
        dv.setUint16(14, 0, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.data.byteLength, true);
        dv.setUint32(24, e.data.byteLength, true);
        dv.setUint16(28, nameBytes.length, true);
        dv.setUint16(30, 0, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, e.offset, true);
        central.set(nameBytes, 46);
        centralEntries.push(central);
        centralSize += central.byteLength;
      }
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, centralStart, true);
      const total =
        parts.reduce((s, p) => s + p.byteLength, 0) + centralSize + eocd.byteLength;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
      }
      for (const c of centralEntries) {
        out.set(c, off);
        off += c.byteLength;
      }
      out.set(eocd, off);
      return out;
    },
  };
}

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function runPaymentJob(env: Env['Bindings'], jobId: string): Promise<void> {
  const job = await getPaymentJobById(env.DB, jobId);
  if (!job) {
    console.error(`[payment-batch-job] job ${jobId} not found`);
    return;
  }
  if (job.status !== 'queued') {
    console.warn(`[payment-batch-job] job ${jobId} status=${job.status}, skipping`);
    return;
  }
  // 二重実行防止: 条件付き UPDATE が 1 行影響していなければ
  // 他 invocation が既に処理を始めているので何もしない
  const claimed = await tryMarkPaymentJobRunning(env.DB, jobId);
  if (!claimed) {
    console.warn(`[payment-batch-job] job ${jobId} already claimed by another invocation`);
    return;
  }

  try {
    const batch = await getConfirmedBatchByPeriod(env.DB, job.period);
    if (!batch) {
      await markPaymentJobFailed(env.DB, jobId, `no confirmed batch for ${job.period}`);
      return;
    }

    const drivers = await listDrivers(env.DB, { activeOnly: true });
    const zipBuilder = createZip();

    let done = 0;
    for (const d of drivers) {
      const deduction = await getDriverDeduction(env.DB, d.id, job.period);
      const records = await listClientRecordsByDriverPeriod(env.DB, d.id, job.period);
      const payment = calculatePayment({
        driver: { hasInvoice: Boolean(d.has_invoice) },
        rates: { commissionRate: batch.commission_rate, taxRate: batch.tax_rate },
        deductions: {
          vehicleCost: deduction?.vehicle_cost ?? 0,
          processingFee: deduction?.processing_fee ?? 0,
          prepayment: deduction?.prepayment ?? 0,
        },
        records: records.map((r) => ({ fare: r.fare, advancePayment: r.advance_payment })),
      });
      const summary = await upsertDriverPaymentSummary(env.DB, {
        driverId: d.id,
        period: job.period,
        importBatchId: batch.id,
        paymentJobId: jobId,
        driverNameSnapshot: d.name,
        hasInvoiceSnapshot: Boolean(d.has_invoice),
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
      const xlsx = buildDriverExcel({
        driver: { name: d.name, hasInvoice: Boolean(d.has_invoice) },
        period: job.period,
        records: records.map((r) => ({
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
        result: payment,
      });
      const xlsxKey = `generated/${job.period}/${jobId}/${makeFileName(job.period, d.name)}`;
      if (env.STEELO_FILES) {
        await env.STEELO_FILES.put(xlsxKey, xlsx, {
          httpMetadata: {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        });
        await env.DB
          .prepare(`UPDATE driver_payment_summaries SET r2_xlsx_key = ? WHERE id = ?`)
          .bind(xlsxKey, summary.id)
          .run();
      }
      zipBuilder.file(makeFileName(job.period, d.name), xlsx);

      done++;
      await updatePaymentJobProgress(env.DB, jobId, done, drivers.length);
    }

    const zipBytes = await zipBuilder.generateAsync({ type: 'uint8array' });
    const zipKey = `generated/${job.period}/${jobId}/all.zip`;
    if (env.STEELO_FILES) {
      await env.STEELO_FILES.put(zipKey, zipBytes, {
        httpMetadata: { contentType: 'application/zip' },
      });
    }
    await markPaymentJobCompleted(env.DB, jobId, zipKey);
    await recordSystemAudit(env.DB, {
      action: 'payment_batch_generate',
      resourceType: 'payment_job',
      resourceId: jobId,
      payload: { period: job.period, drivers: drivers.length },
    });
  } catch (err) {
    console.error(`[payment-batch-job] job ${jobId} failed:`, err);
    await markPaymentJobFailed(env.DB, jobId, String(err));
  }
}
