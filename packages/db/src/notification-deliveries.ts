// STEELO Phase 3 F9: notification_deliveries (永続化送信キュー)
//
// Codex Phase 3 round 1 HIGH #13: idempotency_key UNIQUE で enqueue 重複防止
// Codex Phase 3 round 2 HIGH #2: claim 機構 (status='processing' + claimed_at +
//   claimed_by) で送信時の二重送信防止
// Codex Phase 3 round 2 MEDIUM #7: event_payload_json + payload_schema_ver で
//   再送互換性確保 (Block Kit / Flex Message は送信時に組立)
import { jstNow, toJstString } from './utils.js';

export interface NotificationDeliveryRow {
  id: string;
  idempotency_key: string;
  event_type: string;
  status: string; // 'pending' | 'processing' | 'sent' | 'failed' | 'skipped'
  attempt_count: number;
  claimed_at: string | null;
  claimed_by: string | null;
  payload_schema_ver: number;
  event_payload_json: string;
  last_error: string | null;
  requested_at: string;
  sent_at: string | null;
  next_retry_at: string | null;
}

export interface EnqueueDeliveryInput {
  idempotencyKey: string;
  eventType: string;
  eventPayloadJson: string;
  payloadSchemaVer?: number;
}

export interface EnqueueDeliveryResult {
  /** false の場合は重複 (idempotency_key UNIQUE で skip) */
  inserted: boolean;
  id: string;
}

/**
 * 通知 enqueue。同 idempotency_key の重複は INSERT OR IGNORE で防ぐ。
 * 戻り値で実際に INSERT されたかを返す。
 */
export async function enqueueDelivery(
  db: D1Database,
  input: EnqueueDeliveryInput,
): Promise<EnqueueDeliveryResult> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT OR IGNORE INTO notification_deliveries
         (id, idempotency_key, event_type, status, attempt_count,
          payload_schema_ver, event_payload_json, requested_at, next_retry_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      input.idempotencyKey,
      input.eventType,
      input.payloadSchemaVer ?? 1,
      input.eventPayloadJson,
      now,
    )
    .run();
  // INSERT 成否は SELECT で確認 (INSERT OR IGNORE は changes でも判定可能だが
  // D1 では .meta.changes が常に 0 を返すケースがあるため SELECT を使う)
  const row = await db
    .prepare(`SELECT id FROM notification_deliveries WHERE idempotency_key = ?`)
    .bind(input.idempotencyKey)
    .first<{ id: string }>();
  const actualId = row?.id ?? id;
  return {
    inserted: actualId === id,
    id: actualId,
  };
}

/**
 * 直近 N 時間以内に同 event_type で `sent | processing | pending` の行があるかチェック。
 * LLM streak cooldown 等の「24h 以内に再送しない」判定に使う。
 */
export async function isCooldownActive(
  db: D1Database,
  eventType: string,
  withinHours: number,
): Promise<boolean> {
  const cutoff = toJstString(new Date(Date.now() - withinHours * 3600 * 1000));
  const r = await db
    .prepare(
      `SELECT id FROM notification_deliveries
       WHERE event_type = ?
         AND status IN ('pending', 'processing', 'sent')
         AND requested_at >= ?
       LIMIT 1`,
    )
    .bind(eventType, cutoff)
    .first<{ id: string }>();
  return r !== null;
}

/**
 * pending な delivery を batch で claim する (Codex round 2 HIGH #2)。
 *
 * SQLite の UPDATE ... RETURNING を使って atomic に status を pending →
 * processing に倒し、claimed_by / claimed_at をセット。同時に走る複数 cron が
 * 同じ row を取り合うことを防ぐ。
 *
 * D1 (SQLite) は UPDATE ... RETURNING に対応している (SQLite 3.35+)。
 */
export async function claimBatch(
  db: D1Database,
  input: { runId: string; limit: number; now?: string },
): Promise<NotificationDeliveryRow[]> {
  const now = input.now ?? jstNow();
  const r = await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'processing',
           claimed_at = ?,
           claimed_by = ?
       WHERE id IN (
         SELECT id FROM notification_deliveries
         WHERE status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY requested_at ASC
         LIMIT ?
       )
       RETURNING *`,
    )
    .bind(now, input.runId, now, input.limit)
    .all<NotificationDeliveryRow>();
  return r.results;
}

/**
 * 死活した processing 行 (claim 後一定時間以上経過) を pending に戻す。
 * dispatcher 自体が落ちた場合の復旧用。
 */
export async function recoverStuckProcessing(
  db: D1Database,
  staleThresholdMinutes = 10,
): Promise<number> {
  const cutoff = toJstString(new Date(Date.now() - staleThresholdMinutes * 60_000));
  const r = await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'pending', claimed_at = NULL, claimed_by = NULL
       WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < ?`,
    )
    .bind(cutoff)
    .run();
  return (r.meta as { changes?: number }).changes ?? 0;
}

export async function markSent(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'sent', sent_at = ?, claimed_at = NULL, claimed_by = NULL
       WHERE id = ?`,
    )
    .bind(jstNow(), id)
    .run();
}

export async function markFailed(
  db: D1Database,
  id: string,
  lastError: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'failed', last_error = ?, claimed_at = NULL, claimed_by = NULL
       WHERE id = ?`,
    )
    .bind(lastError.slice(0, 500), id)
    .run();
}

export async function markSkipped(
  db: D1Database,
  id: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'skipped', last_error = ?, claimed_at = NULL, claimed_by = NULL
       WHERE id = ?`,
    )
    .bind(reason.slice(0, 500), id)
    .run();
}

/**
 * 5xx / timeout retry: status を pending に戻し attempt_count++、
 * next_retry_at = now + 5 分を設定。
 */
export async function incrementAttemptAndRequeue(
  db: D1Database,
  id: string,
  lastError: string,
  retryDelayMinutes = 5,
): Promise<void> {
  const next = toJstString(new Date(Date.now() + retryDelayMinutes * 60_000));
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'pending',
           attempt_count = attempt_count + 1,
           last_error = ?,
           next_retry_at = ?,
           claimed_at = NULL,
           claimed_by = NULL
       WHERE id = ?`,
    )
    .bind(lastError.slice(0, 500), next, id)
    .run();
}

export async function getDeliveryById(
  db: D1Database,
  id: string,
): Promise<NotificationDeliveryRow | null> {
  return db
    .prepare(`SELECT * FROM notification_deliveries WHERE id = ?`)
    .bind(id)
    .first<NotificationDeliveryRow>();
}

export async function listRecentDeliveries(
  db: D1Database,
  limit = 50,
): Promise<NotificationDeliveryRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM notification_deliveries
       ORDER BY requested_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<NotificationDeliveryRow>();
  return r.results;
}
