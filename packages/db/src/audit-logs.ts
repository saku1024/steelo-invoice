// STEELO Phase 1: audit_logs クエリ関数

export interface AuditLogRow {
  id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  resource_type: string;
  resource_id: string;
  payload_json: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface ListAuditLogsOptions {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditLogs(
  db: D1Database,
  opts: ListAuditLogsOptions = {}
): Promise<{ items: AuditLogRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.actorId) {
    where.push('actor_id = ?');
    vals.push(opts.actorId);
  }
  if (opts.action) {
    where.push('action = ?');
    vals.push(opts.action);
  }
  if (opts.resourceType) {
    where.push('resource_type = ?');
    vals.push(opts.resourceType);
  }
  if (opts.resourceId) {
    where.push('resource_id = ?');
    vals.push(opts.resourceId);
  }
  if (opts.from) {
    where.push('created_at >= ?');
    vals.push(opts.from);
  }
  if (opts.to) {
    where.push('created_at <= ?');
    vals.push(opts.to);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs ${w}`)
    .bind(...vals)
    .first<{ n: number }>();
  const r = await db
    .prepare(
      `SELECT * FROM audit_logs ${w}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...vals, limit, offset)
    .all<AuditLogRow>();
  return { items: r.results, total: countRow?.n ?? 0 };
}
