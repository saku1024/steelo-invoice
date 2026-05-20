import { Hono } from 'hono';
import {
  createImportPreview,
  getImportPreview,
  deleteImportPreview,
  confirmImportBatch,
  listImportBatches,
  resolveDriverIdByName,
  ConfirmedBatchAlreadyExistsError,
  type ImportBatchRow,
  type ClientRecordInput,
} from '@line-crm/db';
import type { ImportBatch } from '@line-crm/shared';
import {
  parseExcel,
  ExcelValidationError,
  XLSX_LIMITS,
  type ParsedExcel,
} from '../services/excel-import.js';
import type { Env } from '../index.js';

const excelImports = new Hono<Env>();

function serializeBatch(r: ImportBatchRow): ImportBatch {
  return {
    id: r.id,
    period: r.period,
    fileName: r.file_name,
    totalRecords: r.total_records,
    totalFare: r.total_fare,
    totalAdvance: r.total_advance,
    headerVehicleCost: r.header_vehicle_cost,
    headerProcessingFee: r.header_processing_fee,
    headerPrepayment: r.header_prepayment,
    commissionRate: r.commission_rate,
    taxRate: r.tax_rate,
    templateVersion: r.template_version,
    status: (r.status as 'pending' | 'confirmed' | 'archived') ?? 'pending',
    importedAt: r.imported_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
  };
}

// =============================================================================
// preview
// =============================================================================

excelImports.post('/api/excel-imports/preview', async (c) => {
  try {
    const ct = c.req.header('Content-Type') ?? '';
    if (!ct.startsWith('multipart/form-data')) {
      return c.json({ success: false, error: 'multipart/form-data required' }, 400);
    }
    const form = await c.req.formData();
    const fileEntry = form.get('file');
    if (
      !fileEntry ||
      typeof fileEntry === 'string' ||
      typeof (fileEntry as Blob).arrayBuffer !== 'function'
    ) {
      return c.json({ success: false, error: 'file is required' }, 400);
    }
    const file = fileEntry as Blob & { name?: string; size: number };
    if (file.size > XLSX_LIMITS.maxBytes) {
      return c.json({ success: false, error: 'file too large (>10MB)' }, 413);
    }
    const buffer = await file.arrayBuffer();

    let parsed: ParsedExcel;
    try {
      parsed = parseExcel(buffer);
    } catch (e) {
      if (e instanceof ExcelValidationError) {
        const status = e.code === 'TOO_LARGE' ? 413 : e.code === 'NOT_XLSX' ? 400 : 422;
        return c.json(
          { success: false, error: e.message, code: e.code, details: e.details ?? null },
          status
        );
      }
      throw e;
    }

    // ドライバー名解決と未紐付け件数の集計
    const rowsResolved: ClientRecordInput[] = [];
    const unmatched = new Map<string, number>();
    for (const r of parsed.rows) {
      const driverId = r.driverName
        ? await resolveDriverIdByName(c.env.DB, r.driverName)
        : null;
      if (r.driverName && !driverId) {
        unmatched.set(r.driverName, (unmatched.get(r.driverName) ?? 0) + 1);
      }
      rowsResolved.push({
        driverId,
        workDay: r.workDay,
        dayOfWeek: r.dayOfWeek,
        taskName: r.taskName,
        pickupLocation: r.pickupLocation,
        deliveryLocation: r.deliveryLocation,
        startTime: r.startTime,
        endTime: r.endTime,
        distanceKm: r.distanceKm,
        advancePayment: r.advancePayment,
        fare: r.fare,
        driverName: r.driverName,
        notes: r.notes,
      });
    }

    const previewId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const r2Key = `preview/${previewId}.json`;
    const cacheBody = {
      header: parsed.header,
      rows: rowsResolved,
      fileName: (file as { name?: string }).name ?? 'upload.xlsx',
      warnings: parsed.warnings,
    };

    if (!c.env.STEELO_FILES) {
      // R2 未バインド時は in-DB に JSON を埋めるフォールバック
      console.warn('[excel-imports] STEELO_FILES not bound; falling back to DB-only preview');
    } else {
      await c.env.STEELO_FILES.put(r2Key, JSON.stringify(cacheBody), {
        customMetadata: { period: parsed.header.period, previewId },
      });
    }

    const summary = {
      period: parsed.header.period,
      totalFare: parsed.header.totalFare,
      totalAdvance: parsed.header.totalAdvance,
      headerVehicleCost: parsed.header.headerVehicleCost,
      headerProcessingFee: parsed.header.headerProcessingFee,
      headerPrepayment: parsed.header.headerPrepayment,
      commissionRate: parsed.header.commissionRate,
      taxRate: parsed.header.taxRate,
      rowCount: rowsResolved.length,
      unmatchedDrivers: Array.from(unmatched.entries()).map(([name, count]) => ({ name, count })),
      warnings: parsed.warnings,
    };
    const staff = c.get('staff');
    const fileName = (file as { name?: string }).name ?? 'upload.xlsx';
    await createImportPreview(c.env.DB, {
      previewId,
      period: parsed.header.period,
      fileName,
      rowCount: rowsResolved.length,
      summaryJson: JSON.stringify({ ...summary, cacheBody: c.env.STEELO_FILES ? undefined : cacheBody }),
      r2Key,
      createdBy: staff?.id ?? 'unknown',
      expiresAt,
    });

    return c.json({
      success: true,
      data: {
        previewId,
        summary,
        rows: rowsResolved,
        warnings: parsed.warnings,
        unmatchedDrivers: summary.unmatchedDrivers,
        expiresAt,
      },
    });
  } catch (err) {
    console.error('POST /api/excel-imports/preview error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// confirm
// =============================================================================

excelImports.post('/api/excel-imports/confirm', async (c) => {
  try {
    const body = await c.req.json<{ previewId?: string; overwrite?: boolean }>();
    if (!body.previewId) {
      return c.json({ success: false, error: 'previewId required' }, 400);
    }
    const preview = await getImportPreview(c.env.DB, body.previewId);
    if (!preview) {
      return c.json({ success: false, error: 'preview not found or expired' }, 404);
    }
    if (preview.expires_at < new Date().toISOString()) {
      return c.json({ success: false, error: 'preview expired' }, 404);
    }

    let cacheBody: {
      header: ParsedExcel['header'];
      rows: ClientRecordInput[];
      fileName: string;
      warnings: string[];
    } | null = null;
    if (c.env.STEELO_FILES) {
      const obj = await c.env.STEELO_FILES.get(preview.r2_key);
      if (!obj) {
        return c.json({ success: false, error: 'preview body missing on R2' }, 410);
      }
      cacheBody = JSON.parse(await obj.text());
    } else {
      const summary = JSON.parse(preview.summary_json);
      cacheBody = summary.cacheBody;
    }
    if (!cacheBody) {
      return c.json({ success: false, error: 'preview body unavailable' }, 410);
    }

    const staff = c.get('staff');
    let result;
    try {
      result = await confirmImportBatch(c.env.DB, {
        period: cacheBody.header.period,
        fileName: cacheBody.fileName,
        totalRecords: cacheBody.rows.length,
        totalFare: cacheBody.header.totalFare,
        totalAdvance: cacheBody.header.totalAdvance,
        headerVehicleCost: cacheBody.header.headerVehicleCost,
        headerProcessingFee: cacheBody.header.headerProcessingFee,
        headerPrepayment: cacheBody.header.headerPrepayment,
        commissionRate: cacheBody.header.commissionRate,
        taxRate: cacheBody.header.taxRate,
        templateVersion: cacheBody.header.templateVersion,
        confirmedBy: staff?.id ?? 'unknown',
        rows: cacheBody.rows,
        overwrite: body.overwrite === true,
        // audit を同一 batch に組み込む (Codex impl review MEDIUM #11 反映)
        audit: {
          actorId: staff?.id ?? 'unknown',
          actorName: staff?.name ?? 'unknown',
          ip:
            c.req.header('CF-Connecting-IP') ??
            c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
            null,
          userAgent: c.req.header('User-Agent') ?? null,
        },
      });
    } catch (e) {
      if (e instanceof ConfirmedBatchAlreadyExistsError) {
        return c.json(
          { success: false, error: 'confirmed batch already exists', existingId: e.existingId },
          409
        );
      }
      throw e;
    }
    // preview を掃除
    await deleteImportPreview(c.env.DB, body.previewId);
    if (c.env.STEELO_FILES) {
      await c.env.STEELO_FILES.delete(preview.r2_key);
    }
    return c.json({ success: true, data: { ok: true, batchId: result.batchId, archivedBatchId: result.archivedBatchId } });
  } catch (err) {
    console.error('POST /api/excel-imports/confirm error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// list batches
// =============================================================================

excelImports.get('/api/excel-imports', async (c) => {
  try {
    const period = c.req.query('period') ?? undefined;
    const status = c.req.query('status') ?? undefined;
    const rows = await listImportBatches(c.env.DB, { period, status });
    return c.json({ success: true, data: rows.map(serializeBatch) });
  } catch (err) {
    console.error('GET /api/excel-imports error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default excelImports;
