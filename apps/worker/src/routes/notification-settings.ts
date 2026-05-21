// STEELO Phase 3 F9: notification_settings の REST API
//
// GET: 現在の設定 (line_target_id はマスク表示)
// PUT: 設定を更新 + テスト通知を enqueue
// POST /test: 任意のタイミングで手動テスト送信を enqueue
import { Hono } from 'hono';
import {
  getNotificationSettings,
  updateNotificationSettings,
  enqueueDelivery,
  listRecentDeliveries,
  inferTargetKind,
  maskTargetId,
  isEventEnabled,
  type LineTargetKind,
} from '@line-crm/db';
import type { NotificationEvent } from '@line-crm/shared';
import { safeAudit } from '../services/audit.js';
import type { Env } from '../index.js';

const route = new Hono<Env>();

const ALL_EVENTS: NotificationEvent[] = [
  'reconciliation_completed',
  'monthly_reminder',
  'llm_parse_failed_streak',
];

function serializeSettings(
  row: Awaited<ReturnType<typeof getNotificationSettings>>,
): {
  id: 1;
  lineTargetId: string | null;
  lineTargetIdMasked: string | null;
  lineTargetKind: LineTargetKind | null;
  enabledEvents: NotificationEvent[];
  lastTestAt: string | null;
  lastError: string | null;
  updatedAt: string;
} {
  let enabledEvents: NotificationEvent[] = [];
  try {
    const parsed = JSON.parse(row.enabled_events) as unknown[];
    enabledEvents = parsed.filter((e): e is NotificationEvent =>
      ALL_EVENTS.includes(e as NotificationEvent),
    );
  } catch {
    enabledEvents = [];
  }
  return {
    id: 1,
    // 安全のため API レスポンスでは raw 値ではなくマスクのみ返す
    // 設定中で「現在の target」を確認できる程度の表示に留める
    lineTargetId: null,
    lineTargetIdMasked: maskTargetId(row.line_target_id),
    lineTargetKind: (row.line_target_kind as LineTargetKind | null) ?? null,
    enabledEvents,
    lastTestAt: row.last_test_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /api/notification-settings
 * 現在の通知設定を返す (target_id はマスク済み)。直近 20 件の delivery 履歴も。
 */
route.get('/api/notification-settings', async (c) => {
  try {
    const settings = await getNotificationSettings(c.env.DB);
    const recent = await listRecentDeliveries(c.env.DB, 20);
    return c.json({
      success: true,
      data: {
        settings: serializeSettings(settings),
        recentDeliveries: recent.map((d) => ({
          id: d.id,
          eventType: d.event_type,
          status: d.status,
          attemptCount: d.attempt_count,
          requestedAt: d.requested_at,
          sentAt: d.sent_at,
          lastError: d.last_error,
        })),
      },
    });
  } catch (e) {
    console.error('GET /api/notification-settings error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/notification-settings
 * Body: { lineTargetId?: string | null, enabledEvents?: NotificationEvent[] }
 * 設定を更新する。lineTargetId は null で無効化可能。
 * 更新成功時は自動で 1 通のテスト通知 (event_type=`reconciliation_completed` の
 * dummy payload) を enqueue する。
 */
route.put('/api/notification-settings', async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const lineTargetId =
      body.lineTargetId === null || body.lineTargetId === ''
        ? null
        : typeof body.lineTargetId === 'string'
        ? body.lineTargetId.trim()
        : undefined;

    // バリデーション: prefix が U/C/R + 33 文字 (LINE User/Group/Room ID 仕様) でなければ 400
    // Codex full review MEDIUM #4 反映: 仕様に合わせて長さも厳密チェック
    if (lineTargetId !== undefined && lineTargetId !== null) {
      const kind = inferTargetKind(lineTargetId);
      if (!kind) {
        return c.json(
          {
            success: false,
            error: 'lineTargetId must start with U (user), C (group), or R (room)',
          },
          400,
        );
      }
      // LINE User/Group/Room ID は prefix 1 文字 + hex 32 文字 = 計 33 文字
      if (lineTargetId.length !== 33) {
        return c.json(
          {
            success: false,
            error: `lineTargetId must be 33 characters (prefix + 32 hex), got ${lineTargetId.length}`,
          },
          400,
        );
      }
      if (!/^[UCR][0-9a-f]{32}$/.test(lineTargetId)) {
        return c.json(
          {
            success: false,
            error: 'lineTargetId must match ^[UCR][0-9a-f]{32}$',
          },
          400,
        );
      }
    }

    // enabledEvents バリデーション
    let enabledEvents: NotificationEvent[] | undefined = undefined;
    if (Array.isArray(body.enabledEvents)) {
      enabledEvents = body.enabledEvents.filter((e): e is NotificationEvent =>
        ALL_EVENTS.includes(e as NotificationEvent),
      );
    }

    // 現在の設定を読んで、未指定フィールドは保持
    const current = await getNotificationSettings(c.env.DB);
    const nextTargetId =
      lineTargetId === undefined ? current.line_target_id : lineTargetId;
    const nextEnabled =
      enabledEvents === undefined
        ? (JSON.parse(current.enabled_events) as NotificationEvent[]).filter(
            (e): e is NotificationEvent => ALL_EVENTS.includes(e),
          )
        : enabledEvents;

    const updated = await updateNotificationSettings(c.env.DB, {
      lineTargetId: nextTargetId,
      enabledEvents: nextEnabled,
    });

    // 設定更新の監査ログ (target_id 本体は記録しない、kind と masked のみ)
    await safeAudit(c.env.DB, c, {
      action: 'notification_settings_updated',
      resourceType: 'notification_settings',
      resourceId: '1',
      payload: {
        target_kind: updated.line_target_kind,
        target_id_masked: maskTargetId(updated.line_target_id),
        enabled_events: nextEnabled,
      },
    });

    // Codex full review MEDIUM #5 反映: テスト通知は enabledEvents に依存させない。
    // target_id が新規 / 更新された場合は強制的に reconciliation_completed の
    // dummy payload を enqueue (実送信時に enabled チェックが走る場合は
    // dispatcher が skip する。下記 isTest フラグで dispatcher 側 logic も区別可能)
    if (nextTargetId) {
      const testKey = `settings_test:${Date.now()}`;
      await enqueueDelivery(c.env.DB, {
        idempotencyKey: testKey,
        eventType: 'reconciliation_completed',
        eventPayloadJson: JSON.stringify({
          period: 'TEST',
          matched: 0,
          clientOnly: 0,
          dispatchOnly: 0,
          warningCounts: {},
          adminUrl: '',
          isTest: true,
        }),
      });
    }

    return c.json({ success: true, data: serializeSettings(updated) });
  } catch (e) {
    console.error('PUT /api/notification-settings error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/notification-settings/test
 * 任意のタイミングで手動テスト送信を enqueue する。
 */
route.post('/api/notification-settings/test', async (c) => {
  try {
    const current = await getNotificationSettings(c.env.DB);
    if (!current.line_target_id) {
      return c.json(
        { success: false, error: 'lineTargetId is not configured' },
        400,
      );
    }
    const testKey = `manual_test:${Date.now()}`;
    const result = await enqueueDelivery(c.env.DB, {
      idempotencyKey: testKey,
      eventType: 'reconciliation_completed',
      eventPayloadJson: JSON.stringify({
        period: 'TEST',
        matched: 0,
        clientOnly: 0,
        dispatchOnly: 0,
        warningCounts: {},
        adminUrl: '',
        isTest: true,
      }),
    });
    return c.json({
      success: true,
      data: {
        deliveryId: result.id,
        note: '次の cron */1 (最大 1 分後) に送信されます',
      },
    });
  } catch (e) {
    console.error('POST /api/notification-settings/test error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default route;
