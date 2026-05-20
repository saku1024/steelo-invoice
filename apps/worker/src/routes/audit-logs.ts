import { Hono } from 'hono';
import { listAuditLogs, type AuditLogRow } from '@line-crm/db';
import type { AuditLog } from '@line-crm/shared';
import type { Env } from '../index.js';

const auditLogs = new Hono<Env>();

function serialize(r: AuditLogRow): AuditLog {
  return {
    id: r.id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action as AuditLog['action'],
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    payloadJson: r.payload_json,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at,
  };
}

auditLogs.get('/api/audit-logs', async (c) => {
  try {
    // admin/owner ロールのみ
    const staff = c.get('staff');
    if (!staff || (staff.role !== 'owner' && staff.role !== 'admin')) {
      return c.json({ success: false, error: 'admin role required' }, 403);
    }
    const limitRaw = c.req.query('limit');
    const offsetRaw = c.req.query('offset');
    const limit = limitRaw ? Math.min(Math.max(1, Number(limitRaw)), 500) : undefined;
    const offset = offsetRaw ? Math.max(0, Number(offsetRaw)) : undefined;
    if (limitRaw && Number.isNaN(Number(limitRaw))) {
      return c.json({ success: false, error: 'limit must be a number' }, 400);
    }
    if (offsetRaw && Number.isNaN(Number(offsetRaw))) {
      return c.json({ success: false, error: 'offset must be a number' }, 400);
    }
    const result = await listAuditLogs(c.env.DB, {
      actorId: c.req.query('actor') ?? undefined,
      action: c.req.query('action') ?? undefined,
      resourceType: c.req.query('resource_type') ?? undefined,
      resourceId: c.req.query('resource_id') ?? undefined,
      from: c.req.query('from') ?? undefined,
      to: c.req.query('to') ?? undefined,
      limit,
      offset,
    });
    return c.json({
      success: true,
      data: { items: result.items.map(serialize), total: result.total },
    });
  } catch (err) {
    console.error('GET /api/audit-logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default auditLogs;
