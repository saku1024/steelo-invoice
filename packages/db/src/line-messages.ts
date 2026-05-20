// STEELO Phase 1: line_messages のクエリ関数
import { jstNow } from './utils.js';

export interface LineMessageRow {
  id: string;
  group_id: string;
  driver_id: string | null;
  sender_user_id: string | null;
  sender_name: string | null;
  message_id: string;
  message_type: string;
  message_text: string | null;
  is_dispatch: number;
  is_parsed: number;
  received_at: string;
  created_at: string;
}

export interface InsertLineMessageInput {
  groupId: string;
  driverId?: string | null;
  senderUserId?: string | null;
  senderName?: string | null;
  messageId: string;
  messageType: string;
  messageText?: string | null;
  receivedAt?: string;
}

/**
 * INSERT OR IGNORE — message_id UNIQUE 違反は黙過することで Webhook 再送時の
 * 重複保存を防ぐ。返り値は「新規挿入されたか」のフラグ。
 */
export async function insertLineMessageIgnoreDup(
  db: D1Database,
  input: InsertLineMessageInput
): Promise<{ inserted: boolean; id: string }> {
  const id = crypto.randomUUID();
  const receivedAt = input.receivedAt ?? jstNow();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO line_messages
       (id, group_id, driver_id, sender_user_id, sender_name,
        message_id, message_type, message_text, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.groupId,
      input.driverId ?? null,
      input.senderUserId ?? null,
      input.senderName ?? null,
      input.messageId,
      input.messageType,
      input.messageText ?? null,
      receivedAt
    )
    .run();
  const changes = (result.meta as { changes?: number }).changes ?? 0;
  if (changes > 0) return { inserted: true, id };
  // 既存行があるなら message_id から拾い直す
  const existing = await db
    .prepare(`SELECT id FROM line_messages WHERE message_id = ?`)
    .bind(input.messageId)
    .first<{ id: string }>();
  return { inserted: false, id: existing?.id ?? id };
}

export interface ListLineMessagesOptions {
  driverId?: string;
  groupId?: string;
  from?: string;
  to?: string;
  messageType?: string;
  limit?: number;
  offset?: number;
}

export async function listLineMessages(
  db: D1Database,
  opts: ListLineMessagesOptions = {}
): Promise<{ items: LineMessageRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.driverId) {
    where.push('driver_id = ?');
    vals.push(opts.driverId);
  }
  if (opts.groupId) {
    where.push('group_id = ?');
    vals.push(opts.groupId);
  }
  if (opts.from) {
    where.push('received_at >= ?');
    vals.push(opts.from);
  }
  if (opts.to) {
    where.push('received_at <= ?');
    vals.push(opts.to);
  }
  if (opts.messageType) {
    where.push('message_type = ?');
    vals.push(opts.messageType);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM line_messages ${w}`)
    .bind(...vals)
    .first<{ n: number }>();
  const itemsResult = await db
    .prepare(
      `SELECT * FROM line_messages ${w}
       ORDER BY received_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...vals, limit, offset)
    .all<LineMessageRow>();
  return { items: itemsResult.results, total: countRow?.n ?? 0 };
}

export async function getLineMessageById(
  db: D1Database,
  id: string
): Promise<LineMessageRow | null> {
  return db
    .prepare(`SELECT * FROM line_messages WHERE id = ?`)
    .bind(id)
    .first<LineMessageRow>();
}
