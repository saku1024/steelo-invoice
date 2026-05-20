import { Hono } from 'hono';
import {
  listDispatchRecords,
  getDispatchRecordById,
  createDispatchRecord,
  updateDispatchRecord,
  type DispatchRecordRow,
} from '@line-crm/db';
import type { DispatchRecord } from '@line-crm/shared';
import { recordAudit } from '../services/audit.js';
import type { Env } from '../index.js';

const dispatchRecords = new Hono<Env>();

function serialize(r: DispatchRecordRow): DispatchRecord {
  return {
    id: r.id,
    driverId: r.driver_id,
    workDate: r.work_date,
    taskNumber: r.task_number,
    taskName: r.task_name,
    pickupLocation: r.pickup_location,
    deliveryLocation: r.delivery_location,
    startTime: r.start_time,
    endTime: r.end_time,
    managementNumber: r.management_number,
    rawMessageId: r.raw_message_id,
    confidence: (r.confidence as 'high' | 'medium' | 'low') ?? 'high',
    status: (r.status as 'auto' | 'needs_review' | 'confirmed') ?? 'confirmed',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

dispatchRecords.get('/api/dispatch-records', async (c) => {
  try {
    const driverId = c.req.query('driver_id') ?? undefined;
    const from = c.req.query('from') ?? undefined;
    const to = c.req.query('to') ?? undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    const r = await listDispatchRecords(c.env.DB, { driverId, from, to, limit, offset });
    return c.json({
      success: true,
      data: { items: r.items.map(serialize), total: r.total },
    });
  } catch (err) {
    console.error('GET /api/dispatch-records error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

dispatchRecords.post('/api/dispatch-records', async (c) => {
  try {
    const body = await c.req.json<{ driverId?: string; workDate?: string } & Record<string, unknown>>();
    if (!body.driverId) return c.json({ success: false, error: 'driverId is required' }, 400);
    if (!body.workDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.workDate)) {
      return c.json({ success: false, error: 'workDate must be YYYY-MM-DD' }, 400);
    }
    const row = await createDispatchRecord(c.env.DB, {
      driverId: body.driverId,
      workDate: body.workDate,
      taskNumber: (body.taskNumber as number) ?? null,
      taskName: (body.taskName as string) ?? null,
      pickupLocation: (body.pickupLocation as string) ?? null,
      deliveryLocation: (body.deliveryLocation as string) ?? null,
      startTime: (body.startTime as string) ?? null,
      endTime: (body.endTime as string) ?? null,
      managementNumber: (body.managementNumber as string) ?? null,
      rawMessageId: (body.rawMessageId as string) ?? null,
    });
    await recordAudit(c.env.DB, c, {
      action: 'dispatch_create',
      resourceType: 'dispatch_record',
      resourceId: row.id,
      payload: { driverId: row.driver_id, workDate: row.work_date, taskName: row.task_name },
    });
    return c.json({ success: true, data: serialize(row) }, 201);
  } catch (err) {
    console.error('POST /api/dispatch-records error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

dispatchRecords.patch('/api/dispatch-records/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const before = await getDispatchRecordById(c.env.DB, id);
    if (!before) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<Record<string, unknown>>();
    const updated = await updateDispatchRecord(c.env.DB, id, body);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    await recordAudit(c.env.DB, c, {
      action: 'dispatch_update',
      resourceType: 'dispatch_record',
      resourceId: id,
      payload: {
        changedKeys: Object.keys(body),
        before: { workDate: before.work_date, taskName: before.task_name },
      },
    });
    return c.json({ success: true, data: serialize(updated) });
  } catch (err) {
    console.error('PATCH /api/dispatch-records/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default dispatchRecords;
