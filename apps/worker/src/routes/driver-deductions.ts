import { Hono } from 'hono';
import {
  listDriverDeductions,
  getDriverDeduction,
  upsertDriverDeduction,
  getDriverById,
  type DriverDeductionRow,
} from '@line-crm/db';
import type { DriverDeduction } from '@line-crm/shared';
import type { Env } from '../index.js';
import { safeAudit } from '../services/audit.js';

const driverDeductions = new Hono<Env>();

function serialize(r: DriverDeductionRow): DriverDeduction {
  return {
    id: r.id,
    driverId: r.driver_id,
    period: r.period,
    vehicleCost: r.vehicle_cost,
    processingFee: r.processing_fee,
    prepayment: r.prepayment,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

driverDeductions.get('/api/driver-deductions', async (c) => {
  try {
    const period = c.req.query('period') ?? undefined;
    const driverId = c.req.query('driver_id') ?? undefined;
    const rows = await listDriverDeductions(c.env.DB, { period, driverId });
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    console.error('GET /api/driver-deductions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

driverDeductions.put('/api/driver-deductions', async (c) => {
  try {
    // 受信 body は runtime では何でも来うるため Record<string, unknown> で受ける
    const body = (await c.req.json()) as Record<string, unknown>;

    if (typeof body.driverId !== 'string' || body.driverId.trim() === '' ||
        typeof body.period !== 'string') {
      return c.json({ success: false, error: 'driverId and period are required' }, 400);
    }
    if (!/^\d{4}-\d{2}$/.test(body.period)) {
      return c.json({ success: false, error: 'period must be YYYY-MM' }, 400);
    }
    // 非負整数として正規化（"1000" / 1000 を受ける、負値は拒否、上限 1000 万円）
    const validated: Record<'vehicleCost' | 'processingFee' | 'prepayment', number> = {
      vehicleCost: 0,
      processingFee: 0,
      prepayment: 0,
    };
    for (const k of ['vehicleCost', 'processingFee', 'prepayment'] as const) {
      const raw = body[k];
      let n: number | null = null;
      if (typeof raw === 'number' && Number.isFinite(raw)) n = Math.round(raw);
      else if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Number(raw.trim().replace(/[,\s]/g, ''));
        if (!Number.isNaN(parsed)) n = Math.round(parsed);
      }
      if (n === null || n < 0 || n > 10_000_000) {
        return c.json(
          { success: false, error: `${k} must be integer 0-10000000` },
          400
        );
      }
      validated[k] = n;
    }

    const driver = await getDriverById(c.env.DB, body.driverId);
    if (!driver) return c.json({ success: false, error: 'driver not found' }, 404);

    const before = await getDriverDeduction(c.env.DB, body.driverId, body.period);
    const staff = c.get('staff');
    const row = await upsertDriverDeduction(c.env.DB, {
      driverId: body.driverId,
      period: body.period,
      vehicleCost: validated.vehicleCost,
      processingFee: validated.processingFee,
      prepayment: validated.prepayment,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null,
      updatedBy: staff?.id ?? null,
    });
    await safeAudit(c.env.DB, c, {
      action: 'deduction_update',
      resourceType: 'driver_deduction',
      resourceId: row.id,
      payload: {
        driverId: body.driverId,
        period: body.period,
        before: before
          ? {
              vehicleCost: before.vehicle_cost,
              processingFee: before.processing_fee,
              prepayment: before.prepayment,
            }
          : null,
        after: {
          vehicleCost: row.vehicle_cost,
          processingFee: row.processing_fee,
          prepayment: row.prepayment,
        },
      },
    });
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error('PUT /api/driver-deductions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default driverDeductions;
