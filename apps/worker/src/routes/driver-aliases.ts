import { Hono } from 'hono';
import {
  listDriverAliases,
  createDriverAlias,
  deleteDriverAlias,
  getDriverById,
  DriverAliasDuplicateError,
  type DriverAliasRow,
} from '@line-crm/db';
import type { DriverAlias } from '@line-crm/shared';
import type { Env } from '../index.js';
import { recordAudit } from '../services/audit.js';

const driverAliases = new Hono<Env>();

function serialize(r: DriverAliasRow): DriverAlias {
  return {
    id: r.id,
    driverId: r.driver_id,
    aliasName: r.alias_name,
    createdAt: r.created_at,
  };
}

driverAliases.get('/api/driver-aliases', async (c) => {
  try {
    const driverId = c.req.query('driver_id') ?? undefined;
    const rows = await listDriverAliases(c.env.DB, { driverId });
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    console.error('GET /api/driver-aliases error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

driverAliases.post('/api/driver-aliases', async (c) => {
  try {
    const body = await c.req.json<{ driverId?: string; aliasName?: string }>();
    if (
      typeof body.driverId !== 'string' ||
      typeof body.aliasName !== 'string' ||
      !body.driverId.trim() ||
      !body.aliasName.trim()
    ) {
      return c.json({ success: false, error: 'driverId and aliasName are required' }, 400);
    }
    if (body.aliasName.length > 100) {
      return c.json({ success: false, error: 'aliasName too long (max 100)' }, 400);
    }
    const driver = await getDriverById(c.env.DB, body.driverId);
    if (!driver) return c.json({ success: false, error: 'driver not found' }, 404);
    const created = await createDriverAlias(c.env.DB, {
      driverId: body.driverId,
      aliasName: body.aliasName.trim(),
    });
    await recordAudit(c.env.DB, c, {
      action: 'driver_alias_create',
      resourceType: 'driver_alias',
      resourceId: created.id,
      payload: { driverId: body.driverId, aliasName: body.aliasName },
    });
    return c.json({ success: true, data: serialize(created) }, 201);
  } catch (err) {
    if (err instanceof DriverAliasDuplicateError) {
      return c.json(
        { success: false, error: `alias_name "${err.aliasName}" already in use` },
        409
      );
    }
    console.error('POST /api/driver-aliases error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

driverAliases.delete('/api/driver-aliases/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteDriverAlias(c.env.DB, id);
    await recordAudit(c.env.DB, c, {
      action: 'driver_alias_delete',
      resourceType: 'driver_alias',
      resourceId: id,
    });
    return c.json({ success: true, data: { ok: true } });
  } catch (err) {
    console.error('DELETE /api/driver-aliases/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default driverAliases;
