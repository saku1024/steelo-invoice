import type { WebhookEvent, MessageEvent } from '@line-crm/line-sdk';
import {
  getDriverByLineGroupId,
  insertLineMessageIgnoreDup,
} from '@line-crm/db';
import { recordSystemAudit } from './audit.js';

/**
 * STEELO Phase 1 — LINE グループメッセージハンドラ（F1）。
 *
 * source.type === 'group' の `message` イベントを受け取り、`line_messages` に
 * INSERT OR IGNORE で蓄積する。バイナリ系（image/file/video/audio/sticker）は
 * メタデータのみ保存し、本体はダウンロードしない。
 *
 * 既存の friend / scenario / chats 処理は呼び出さない（個別チャットと
 * グループは別フロー）。
 *
 * 失敗時は `audit_logs` に `webhook_save_failed` を記録（再処理は行わない、
 * message_id UNIQUE で次回再送時に自然に追いつく）。
 */
export async function handleGroupMessage(
  db: D1Database,
  event: WebhookEvent
): Promise<void> {
  if (event.type !== 'message') return;
  if (event.source.type !== 'group') return;

  const messageEvent = event as MessageEvent;
  const groupId = event.source.groupId;
  const senderUserId =
    'userId' in event.source && event.source.userId ? event.source.userId : null;

  const messageId = messageEvent.message.id;
  const messageType = messageEvent.message.type;
  const messageText =
    messageType === 'text' && 'text' in messageEvent.message
      ? (messageEvent.message as { text: string }).text
      : null;

  const receivedAt = messageEvent.timestamp
    ? new Date(messageEvent.timestamp + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00'
    : undefined;

  try {
    const driver = await getDriverByLineGroupId(db, groupId);
    await insertLineMessageIgnoreDup(db, {
      groupId,
      driverId: driver?.id ?? null,
      senderUserId,
      // group event には参加者の表示名は含まれないため null とし、必要なら
      // 別フローで取得する（Phase 1 ではメタデータのみ蓄積）
      senderName: null,
      messageId,
      messageType,
      messageText,
      receivedAt,
    });
  } catch (err) {
    console.error('[group-message-handler] save failed:', err);
    try {
      await recordSystemAudit(db, {
        action: 'webhook_save_failed',
        resourceType: 'line_message',
        resourceId: messageId,
        payload: { groupId, messageType, error: String(err) },
      });
    } catch (logErr) {
      console.error('[group-message-handler] audit log also failed:', logErr);
    }
  }
}

/**
 * 既存 webhook.ts から呼び出すための判定ヘルパ。
 * グループ宛 message なら true。
 */
export function isGroupMessageEvent(event: WebhookEvent): boolean {
  return event.type === 'message' && event.source.type === 'group';
}
