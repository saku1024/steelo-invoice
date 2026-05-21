// STEELO Phase 3 F9: notification-dispatcher
//
// cron `*/1 * * * *` で起動され、notification_deliveries の `pending` 行を
// claim → LINE 送信 → sent/failed/requeue に倒す。
//
// Codex Phase 3 round 2 HIGH #2 反映:
//   - 死活した processing 行 (10 分以上前に claim) を pending に戻す
//   - atomic claim (UPDATE ... RETURNING) で複数 cron invocation の競合を防ぐ
//   - 4xx → failed, 5xx/timeout → requeue (next_retry_at +5m, attempt_count++)
//   - attempt_count >= 6 で failed に倒す
import {
  claimBatch,
  recoverStuckProcessing,
  markSent,
  markFailed,
  markSkipped,
  incrementAttemptAndRequeue,
  getNotificationSettings,
  recordTestResult,
  recordSendError,
  isEventEnabled,
  type NotificationDeliveryRow,
} from '@line-crm/db';
import { sendDeliveryViaLine } from './line-notifier.js';
import { recordSystemAudit } from './audit.js';
import type { NotificationEvent } from '@line-crm/shared';
import type { Env } from '../index.js';

const MAX_BATCH_SIZE = 10;
const MAX_ATTEMPTS = 6;
const STALE_PROCESSING_MIN = 10;

export interface DispatcherResult {
  recoveredStuck: number;
  claimed: number;
  sent: number;
  failed: number;
  requeued: number;
  skipped: number;
}

/**
 * cron 1 分粒度のメインエントリ (event.cron 表記: 毎分実行)。
 * 1 回の invocation で:
 *   1. 死活した processing を pending に戻す (stale recovery)
 *   2. notification_settings をロード
 *   3. pending を atomic claim (最大 10 件)
 *   4. 各 row を順次 LINE に送信、結果に応じて sent/failed/requeue
 */
export async function runNotificationDispatcher(
  env: Env['Bindings'],
): Promise<DispatcherResult> {
  const result: DispatcherResult = {
    recoveredStuck: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    requeued: 0,
    skipped: 0,
  };

  // 1. stale recovery
  try {
    result.recoveredStuck = await recoverStuckProcessing(env.DB, STALE_PROCESSING_MIN);
    if (result.recoveredStuck > 0) {
      console.log(
        `[notification-dispatcher] recovered ${result.recoveredStuck} stuck processing rows`,
      );
    }
  } catch (e) {
    console.error('[notification-dispatcher] stale recovery error:', e);
  }

  // 2. settings
  const settings = await getNotificationSettings(env.DB);
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetId = settings.line_target_id;

  // 通知設定が空 (target_id 未登録) → claim せず終了
  if (!targetId || !token || token === '') {
    return result;
  }

  // 3. claim
  const runId = crypto.randomUUID();
  let claimed: NotificationDeliveryRow[] = [];
  try {
    claimed = await claimBatch(env.DB, { runId, limit: MAX_BATCH_SIZE });
    result.claimed = claimed.length;
  } catch (e) {
    console.error('[notification-dispatcher] claim error:', e);
    return result;
  }

  // 4. 各 row を順次処理
  for (const row of claimed) {
    // event_type が enabled でない → skipped
    if (!isEventEnabled(settings, row.event_type)) {
      try {
        await markSkipped(env.DB, row.id, `event_type ${row.event_type} not enabled`);
        await recordSystemAudit(env.DB, {
          action: 'notification_skipped',
          resourceType: 'notification_delivery',
          resourceId: row.id,
          payload: { event_type: row.event_type, reason: 'not_enabled' },
        });
        result.skipped++;
      } catch (e) {
        console.error('[notification-dispatcher] markSkipped error:', e);
      }
      continue;
    }

    // attempt_count >= MAX_ATTEMPTS → 即 failed
    if (row.attempt_count >= MAX_ATTEMPTS) {
      try {
        await markFailed(env.DB, row.id, `attempt_count exceeded ${MAX_ATTEMPTS}`);
        await recordSystemAudit(env.DB, {
          action: 'notification_failed',
          resourceType: 'notification_delivery',
          resourceId: row.id,
          payload: {
            event_type: row.event_type,
            attempt_count: row.attempt_count,
            reason: 'max_attempts',
          },
        });
        await recordSendError(env.DB, `max_attempts (${MAX_ATTEMPTS})`);
        result.failed++;
      } catch (e) {
        console.error('[notification-dispatcher] markFailed error:', e);
      }
      continue;
    }

    // 実送信
    try {
      const sendResult = await sendDeliveryViaLine(
        {
          id: row.id,
          idempotencyKey: row.idempotency_key,
          eventType: row.event_type as NotificationEvent,
          payloadSchemaVer: row.payload_schema_ver,
          eventPayloadJson: row.event_payload_json,
          attemptCount: row.attempt_count,
        },
        { channelAccessToken: token, targetId },
      );

      if (sendResult.sent) {
        await markSent(env.DB, row.id);
        await recordTestResult(env.DB).catch(() => undefined);
        await recordSystemAudit(env.DB, {
          action: 'notification_sent',
          resourceType: 'notification_delivery',
          resourceId: row.id,
          payload: {
            event_type: row.event_type,
            http_status: sendResult.httpStatus,
            attempt_count: row.attempt_count + 1,
          },
        });
        result.sent++;
      } else if (sendResult.retryable) {
        // 5xx / timeout → requeue
        await incrementAttemptAndRequeue(
          env.DB,
          row.id,
          sendResult.error ?? 'retryable error',
          5,
        );
        await recordSendError(env.DB, sendResult.error ?? 'retryable error');
        result.requeued++;
      } else {
        // 4xx → 即 failed
        await markFailed(env.DB, row.id, sendResult.error ?? '4xx error');
        await recordSendError(env.DB, sendResult.error ?? '4xx error');
        await recordSystemAudit(env.DB, {
          action: 'notification_failed',
          resourceType: 'notification_delivery',
          resourceId: row.id,
          payload: {
            event_type: row.event_type,
            http_status: sendResult.httpStatus,
            reason: '4xx',
          },
        });
        result.failed++;
      }
    } catch (e) {
      // 想定外エラー: requeue する (次回 cron で再試行)
      console.error(`[notification-dispatcher] unexpected error for ${row.id}:`, e);
      try {
        await incrementAttemptAndRequeue(
          env.DB,
          row.id,
          e instanceof Error ? `unexpected: ${e.message}` : 'unexpected error',
          5,
        );
        result.requeued++;
      } catch (e2) {
        console.error('[notification-dispatcher] requeue error:', e2);
      }
    }
  }

  return result;
}
