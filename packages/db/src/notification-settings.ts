// STEELO Phase 3 F9: notification_settings (id=1 単一行)
//
// LINE Messaging API push_message の送信先と有効化イベントを管理する。
// LINE_CHANNEL_ACCESS_TOKEN は wrangler secret で別管理 (Phase 1 のものを流用)。
import { jstNow } from './utils.js';

export interface NotificationSettingsRow {
  id: number;
  line_target_id: string | null;
  line_target_kind: string | null; // 'user' | 'group' | 'room'
  enabled_events: string;          // JSON
  last_test_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export type LineTargetKind = 'user' | 'group' | 'room';

export interface NotificationSettingsInput {
  lineTargetId: string | null;
  enabledEvents?: string[];
}

/**
 * line_target_id の先頭文字から target_kind を判定する。
 * U... = user, C... = group, R... = room
 * いずれにも該当しない、または null の場合は null。
 */
export function inferTargetKind(targetId: string | null): LineTargetKind | null {
  if (!targetId) return null;
  if (targetId.startsWith('U')) return 'user';
  if (targetId.startsWith('C')) return 'group';
  if (targetId.startsWith('R')) return 'room';
  return null;
}

/**
 * line_target_id をマスクして返す (先頭 5 + 末尾 4)。
 * 例: U1234567890abcdef → "U1234...cdef"
 */
export function maskTargetId(targetId: string | null): string | null {
  if (!targetId) return null;
  if (targetId.length <= 9) return targetId; // 短すぎる場合はそのまま
  return `${targetId.slice(0, 5)}...${targetId.slice(-4)}`;
}

export async function getNotificationSettings(
  db: D1Database,
): Promise<NotificationSettingsRow> {
  const r = await db
    .prepare(`SELECT * FROM notification_settings WHERE id = 1`)
    .first<NotificationSettingsRow>();
  if (!r) {
    // migration 048 で INSERT OR IGNORE しているので通常は発生しない。
    // 念のため最低限の行を返す。
    return {
      id: 1,
      line_target_id: null,
      line_target_kind: null,
      enabled_events: '[]',
      last_test_at: null,
      last_error: null,
      updated_at: jstNow(),
    };
  }
  return r;
}

export async function updateNotificationSettings(
  db: D1Database,
  input: NotificationSettingsInput,
): Promise<NotificationSettingsRow> {
  const targetKind = inferTargetKind(input.lineTargetId);
  const enabledEventsJson = JSON.stringify(input.enabledEvents ?? []);
  await db
    .prepare(
      `UPDATE notification_settings SET
         line_target_id = ?,
         line_target_kind = ?,
         enabled_events = ?,
         updated_at = ?
       WHERE id = 1`,
    )
    .bind(input.lineTargetId, targetKind, enabledEventsJson, jstNow())
    .run();
  return getNotificationSettings(db);
}

export async function recordTestResult(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_settings SET last_test_at = ?, last_error = NULL WHERE id = 1`,
    )
    .bind(jstNow())
    .run();
}

/**
 * LINE API HTTP status + 短い error message のみ記録。
 * token を含む response body は記録しない。
 */
export async function recordSendError(
  db: D1Database,
  errorSummary: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_settings SET last_error = ?, updated_at = ? WHERE id = 1`,
    )
    .bind(errorSummary.slice(0, 500), jstNow())
    .run();
}

/**
 * `enabled_events` JSON 配列に指定 event_type が含まれているかをチェック。
 */
export function isEventEnabled(
  settings: NotificationSettingsRow,
  eventType: string,
): boolean {
  try {
    const arr = JSON.parse(settings.enabled_events) as unknown[];
    return Array.isArray(arr) && arr.includes(eventType);
  } catch {
    return false;
  }
}
