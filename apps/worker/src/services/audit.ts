import type { Context } from 'hono';
import type { AuditAction } from '@line-crm/shared';
import type { Env } from '../index.js';

export interface AuditEntry {
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  payload?: unknown;
}

/**
 * STEELO Phase 1 の監査証跡を `audit_logs` に永続化する。
 *
 * 重要操作（インポート確定、支払明細生成、マスタ変更等）は必ず呼び出す。
 * 呼び出し側のトランザクション内で実行できるよう、D1Database を引数で受け取る。
 *
 * - actor は Hono Context の `staff` Variables から解決する（既存 auth middleware
 *   が設定済み）
 * - payload は JSON 文字列化して保存（before/after の差分などに使う）
 */
export async function recordAudit(
  db: D1Database,
  c: Context<Env>,
  entry: AuditEntry
): Promise<void> {
  const staff = c.get('staff') ?? { id: 'unknown', name: 'unknown' };
  const id = crypto.randomUUID();
  const ip =
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    null;
  const userAgent = c.req.header('User-Agent') ?? null;
  const payloadJson = entry.payload === undefined ? null : JSON.stringify(entry.payload);

  await db
    .prepare(
      `INSERT INTO audit_logs
       (id, actor_id, actor_name, action, resource_type, resource_id,
        payload_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      staff.id,
      staff.name,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      payloadJson,
      ip,
      userAgent
    )
    .run();
}

/**
 * Context の取れない場面（Webhook の waitUntil 等）から呼び出すための簡易版。
 * actor が確定できない場合に system actor を使う。
 */
export async function recordSystemAudit(
  db: D1Database,
  entry: AuditEntry & { actorId?: string; actorName?: string }
): Promise<void> {
  const id = crypto.randomUUID();
  const payloadJson = entry.payload === undefined ? null : JSON.stringify(entry.payload);

  await db
    .prepare(
      `INSERT INTO audit_logs
       (id, actor_id, actor_name, action, resource_type, resource_id,
        payload_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      id,
      entry.actorId ?? 'system',
      entry.actorName ?? 'system',
      entry.action,
      entry.resourceType,
      entry.resourceId,
      payloadJson
    )
    .run();
}
