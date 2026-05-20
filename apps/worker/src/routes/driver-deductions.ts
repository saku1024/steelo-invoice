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
import { recordAudit } from '../services/audit.js';

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
    const body = await c.req.json<{
      driverId?: string;
      period?: string;
      vehicleCost?: number;
      processingFee?: number;
      prepayment?: number;
      notes?: string | null;
    }>();

    if (!body.driverId || !body.period) {
      return c.json({ success: false, error: 'driverId and period are required' }, 400);
    }
    if (!/^\d{4}-\d{2}$/.test(body.period)) {
      return c.json({ success: false, error: 'period must be YYYY-MM' }, 400);
    }
    for (const k of ['vehicleCost', 'processingFee', 'prepayment'] as const) {
      const v = body[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        return c.json({ success: false, error: `${k} must be a non-negative integer` }, 400);
      }
    }

    const driver = await getDriverById(c.env.DB, body.driverId);
    if (!driver) return c.json({ success: false, error: 'driver not found' }, 404);

    const before = await getDriverDeduction(c.env.DB, body.driverId, body.period);
    const staff = c.get('staff');
    const row = await upsertDriverDeduction(c.env.DB, {
      driverId: body.driverId,
      period: body.period,
      vehicleCost: body.vehicleCost as number,
      processingFee: body.processingFee as number,
      prepayment: body.prepayment as number,
      notes: body.notes ?? null,
      updatedBy: staff?.id ?? null,
    });
    await recordAudit(c.env.DB, c, {
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
