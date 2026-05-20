import { Hono } from 'hono';
import {
  listDrivers,
  getDriverById,
  createDriver,
  updateDriver,
  archiveDriver,
  DriverDuplicateGroupIdError,
  type DriverRow,
} from '@line-crm/db';
import type { Driver } from '@line-crm/shared';
import type { Env } from '../index.js';
import { recordAudit } from '../services/audit.js';

const drivers = new Hono<Env>();

function serialize(r: DriverRow): Driver {
  return {
    id: r.id,
    name: r.name,
    nameKana: r.name_kana,
    lineGroupId: r.line_group_id,
    lineGroupName: r.line_group_name,
    hasInvoice: Boolean(r.has_invoice),
    isActive: Boolean(r.is_active),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

drivers.get('/api/drivers', async (c) => {
  try {
    const activeOnly = c.req.query('active') === 'true';
    const rows = await listDrivers(c.env.DB, { activeOnly });
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    console.error('GET /api/drivers error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

drivers.get('/api/drivers/:id', async (c) => {
  try {
    const row = await getDriverById(c.env.DB, c.req.param('id'));
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error('GET /api/drivers/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

drivers.post('/api/drivers', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json({ success: false, error: 'name is required' }, 400);
    }
    // boolean 系は文字列 'false' を true 扱いしない
    const created = await createDriver(c.env.DB, {
      name: (body.name as string).trim(),
      nameKana: optString(body.nameKana),
      lineGroupId: optString(body.lineGroupId),
      lineGroupName: optString(body.lineGroupName),
      hasInvoice: asBool(body.hasInvoice, false),
      isActive: asBool(body.isActive, true),
      notes: optString(body.notes),
    });
    await recordAudit(c.env.DB, c, {
      action: 'driver_create',
      resourceType: 'driver',
      resourceId: created.id,
      payload: { name: created.name, lineGroupId: created.line_group_id },
    });
    return c.json({ success: true, data: serialize(created) }, 201);
  } catch (err) {
    if (err instanceof DriverDuplicateGroupIdError) {
      return c.json(
        { success: false, error: `line_group_id "${err.lineGroupId}" already in use` },
        409
      );
    }
    console.error('POST /api/drivers error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

drivers.patch('/api/drivers/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const before = await getDriverById(c.env.DB, id);
    if (!before) return c.json({ success: false, error: 'Not found' }, 404);
    const updated = await updateDriver(c.env.DB, id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      nameKana: 'nameKana' in body ? optString(body.nameKana) : undefined,
      lineGroupId: 'lineGroupId' in body ? optString(body.lineGroupId) : undefined,
      lineGroupName: 'lineGroupName' in body ? optString(body.lineGroupName) : undefined,
      hasInvoice: 'hasInvoice' in body ? asBool(body.hasInvoice, false) : undefined,
      isActive: 'isActive' in body ? asBool(body.isActive, true) : undefined,
      notes: 'notes' in body ? optString(body.notes) : undefined,
    });
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    await recordAudit(c.env.DB, c, {
      action: 'driver_update',
      resourceType: 'driver',
      resourceId: id,
      payload: { changedKeys: Object.keys(body) },
    });
    return c.json({ success: true, data: serialize(updated) });
  } catch (err) {
    if (err instanceof DriverDuplicateGroupIdError) {
      return c.json(
        { success: false, error: `line_group_id "${err.lineGroupId}" already in use` },
        409
      );
    }
    console.error('PATCH /api/drivers/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** 物理削除はせず is_active=0 への論理削除 */
drivers.delete('/api/drivers/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await archiveDriver(c.env.DB, id);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    await recordAudit(c.env.DB, c, {
      action: 'driver_archive',
      resourceType: 'driver',
      resourceId: id,
    });
    return c.json({ success: true, data: { ok: true } });
  } catch (err) {
    console.error('DELETE /api/drivers/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

function optString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
  }
  return fallback;
}

export default drivers;
