import { Hono } from 'hono';
import {
  listDispatchRecords,
  getDispatchRecordById,
  getDriverById,
  createDispatchRecord,
  updateDispatchRecord,
  type DispatchRecordRow,
} from '@line-crm/db';
import type { DispatchRecord } from '@line-crm/shared';
import { safeAudit } from '../services/audit.js';
import {
  asDateStr,
  asInt,
  asTimeStr,
  clampLimit,
  clampOffset,
  isNonEmptyString,
  optString,
} from '../services/validation.js';
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
    const from = asDateStr(c.req.query('from')) ?? undefined;
    const to = asDateStr(c.req.query('to')) ?? undefined;
    const limit = clampLimit(c.req.query('limit'), 100, 500);
    const offset = clampOffset(c.req.query('offset'));
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
    const body = await c.req.json<Record<string, unknown>>();
    if (!isNonEmptyString(body.driverId)) {
      return c.json({ success: false, error: 'driverId is required' }, 400);
    }
    const workDate = asDateStr(body.workDate);
    if (!workDate) {
      return c.json({ success: false, error: 'workDate must be YYYY-MM-DD' }, 400);
    }
    // driver 存在チェック（FK 違反による 500 を防ぐ）
    const driver = await getDriverById(c.env.DB, body.driverId);
    if (!driver) return c.json({ success: false, error: 'driver not found' }, 404);
    const taskNumber = body.taskNumber === undefined ? null : asInt(body.taskNumber);
    if (body.taskNumber !== undefined && (taskNumber === null || taskNumber < 0 || taskNumber > 99)) {
      return c.json({ success: false, error: 'taskNumber must be integer 0-99' }, 400);
    }
    const row = await createDispatchRecord(c.env.DB, {
      driverId: body.driverId,
      workDate,
      taskNumber,
      taskName: optString(body.taskName, 200),
      pickupLocation: optString(body.pickupLocation, 200),
      deliveryLocation: optString(body.deliveryLocation, 200),
      startTime: asTimeStr(body.startTime),
      endTime: asTimeStr(body.endTime),
      managementNumber: optString(body.managementNumber, 100),
      rawMessageId: optString(body.rawMessageId, 100),
    });
    await safeAudit(c.env.DB, c, {
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
    // workDate/time/taskNumber は形式検証
    if ('workDate' in body && !asDateStr(body.workDate)) {
      return c.json({ success: false, error: 'workDate must be YYYY-MM-DD' }, 400);
    }
    if ('startTime' in body && body.startTime !== null && asTimeStr(body.startTime) === null) {
      return c.json({ success: false, error: 'startTime must be HH:MM' }, 400);
    }
    if ('endTime' in body && body.endTime !== null && asTimeStr(body.endTime) === null) {
      return c.json({ success: false, error: 'endTime must be HH:MM' }, 400);
    }
    if ('taskNumber' in body && body.taskNumber !== null) {
      const n = asInt(body.taskNumber);
      if (n === null || n < 0 || n > 99) {
        return c.json({ success: false, error: 'taskNumber must be integer 0-99' }, 400);
      }
    }
    const updated = await updateDispatchRecord(c.env.DB, id, body);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    await safeAudit(c.env.DB, c, {
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
