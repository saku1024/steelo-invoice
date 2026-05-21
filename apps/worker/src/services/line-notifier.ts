// STEELO Phase 3 F9: LINE Messaging API push_message ラッパー
//
// Codex Phase 3 round 1 CRITICAL #4 / round 2 補強 反映:
//   - 各 fetch を AbortController で 5 秒 timeout
//   - retry sleep 1s → 3s → 8s (累積最悪 27 秒、waitUntil 30s 制限内)
//   - 4xx は即 failed、5xx / timeout は requeue (status pending + next_retry_at)
//   - URL / token は last_error / audit_logs に含めない
//
// Codex Phase 3 round 2 MEDIUM #7 / round 4 HIGH #1 反映:
//   - notifier の入力は notification_deliveries 行そのもの (DeliveryJob)
//   - payload_schema_ver を見て送信時に Flex Message / text を組み立てる
//   - 呼べるのは notification-dispatcher (cron */1) と
//     /api/notification-settings/test のテストエンドポイントのみ
import type { NotificationEvent } from '@line-crm/shared';

export interface DeliveryJob {
  id: string;
  idempotencyKey: string;
  eventType: NotificationEvent;
  payloadSchemaVer: number;
  eventPayloadJson: string;
  attemptCount: number;
}

export interface NotifierResult {
  sent: boolean;
  /** HTTP status (200 OK 以外の場合) */
  httpStatus?: number;
  /** retry 可能 (5xx / timeout / abort 等)、false なら即 failed */
  retryable?: boolean;
  /** last_error に保存するための短いメッセージ。token を含めない */
  error?: string;
}

/** LINE Messaging API push に送信するメッセージ (text or flex 等) */
export interface LineMessage {
  type: string;
  text?: string;
  altText?: string;
  contents?: unknown;
}

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const FETCH_TIMEOUT_MS = 5_000;
/** sleep の合計 = 12s、fetch 3 回で +15s = 27s total (waitUntil 30s 制限内) */
const RETRY_SLEEPS_MS = [1_000, 3_000, 8_000];

export interface NotifierDeps {
  channelAccessToken: string;
  /** push 先 (User/Group/Room ID) */
  targetId: string;
  /** abort signal (テスト用)。未指定なら内部で生成 */
  signal?: AbortSignal;
  /** sleep 関数を注入可能 (テスト用) */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Delivery 1 件を LINE に送信する。retry / cooldown / claim 解放等は
 * 呼び出し側 (notification-dispatcher) が行う。
 */
export async function sendDeliveryViaLine(
  job: DeliveryJob,
  deps: NotifierDeps,
): Promise<NotifierResult> {
  const messages = buildMessages(job);
  const body = JSON.stringify({ to: deps.targetId, messages });
  const sleep = deps.sleep ?? defaultSleep;

  // sleep → fetch → 判定を最大 3 回 (sleep [1s, 3s, 8s])
  let lastResult: NotifierResult | null = null;
  for (let attempt = 0; attempt < RETRY_SLEEPS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_SLEEPS_MS[attempt - 1]);
    }
    const r = await sendOnce(body, deps);
    lastResult = r;
    if (r.sent) return r;
    if (!r.retryable) return r; // 4xx は即 failed
  }
  return lastResult ?? {
    sent: false,
    retryable: true,
    error: 'no attempt made',
  };
}

async function sendOnce(body: string, deps: NotifierDeps): Promise<NotifierResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.channelAccessToken}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    if (resp.status === 200) return { sent: true, httpStatus: 200 };
    // 4xx は retry しない (auth / target 不正等は時間で直らない)
    if (resp.status >= 400 && resp.status < 500) {
      // response body はサイズ制限して保存。token / 機微情報を含めないよう
      // 先頭 200 文字に切る (LINE の error response は機微情報を含まないが念のため)
      const text = await safeReadText(resp);
      return {
        sent: false,
        retryable: false,
        httpStatus: resp.status,
        error: `LINE ${resp.status}: ${text.slice(0, 200)}`,
      };
    }
    // 5xx は retryable
    const text = await safeReadText(resp);
    return {
      sent: false,
      retryable: true,
      httpStatus: resp.status,
      error: `LINE ${resp.status}: ${text.slice(0, 200)}`,
    };
  } catch (e) {
    // timeout / network error
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      return {
        sent: false,
        retryable: true,
        error: `LINE timeout (${FETCH_TIMEOUT_MS}ms)`,
      };
    }
    return {
      sent: false,
      retryable: true,
      error: e instanceof Error ? `LINE network: ${e.message}` : 'LINE network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '<no body>';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// =============================================================================
// Message builders
// =============================================================================

/**
 * event_payload_json + payload_schema_ver から LINE message[] を組み立てる。
 * 将来 payload_schema_ver を bump する場合はここに分岐を追加する。
 */
export function buildMessages(job: DeliveryJob): LineMessage[] {
  if (job.payloadSchemaVer !== 1) {
    return [
      {
        type: 'text',
        text: `[STEELO] 未知の payload schema ver=${job.payloadSchemaVer}`,
      },
    ];
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(job.eventPayloadJson);
  } catch {
    return [
      { type: 'text', text: `[STEELO] payload parse error (event=${job.eventType})` },
    ];
  }
  return buildMessagesV1(job.eventType, payload);
}

function buildMessagesV1(
  eventType: NotificationEvent,
  p: Record<string, unknown>,
): LineMessage[] {
  switch (eventType) {
    case 'reconciliation_completed':
      return [buildReconciliationCompletedText(p)];
    case 'monthly_reminder':
      return [buildMonthlyReminderText(p)];
    case 'llm_parse_failed_streak':
      return [buildLLMFailureStreakText(p)];
    default:
      return [{ type: 'text', text: `[STEELO] 未対応イベント: ${eventType}` }];
  }
}

function buildReconciliationCompletedText(p: Record<string, unknown>): LineMessage {
  const period = String(p.period ?? '');
  const matched = Number(p.matched ?? 0);
  const clientOnly = Number(p.clientOnly ?? 0);
  const dispatchOnly = Number(p.dispatchOnly ?? 0);
  const warningCounts = (p.warningCounts ?? {}) as Record<string, number>;
  const adminUrl = String(p.adminUrl ?? '');

  let text = `✅ ${period} 月の照合が完了しました\n`;
  text += `matched: ${matched} / client_only: ${clientOnly} / dispatch_only: ${dispatchOnly}\n`;

  const warningSummary = Object.entries(warningCounts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${type} ${n} 件`)
    .join(' / ');
  if (warningSummary) {
    text += `⚠️ 異常: ${warningSummary}\n`;
  }
  if (adminUrl) {
    text += `詳細: ${adminUrl}`;
  }
  return { type: 'text', text: text.trim() };
}

function buildMonthlyReminderText(p: Record<string, unknown>): LineMessage {
  const prevPeriod = String(p.prevPeriod ?? '');
  return {
    type: 'text',
    text: `📋 前月 (${prevPeriod}) の元請け Excel がまだ取り込まれていません。
管理画面で「Excelインポート」から取り込んでください。`,
  };
}

function buildLLMFailureStreakText(p: Record<string, unknown>): LineMessage {
  const count = Number(p.count ?? 0);
  return {
    type: 'text',
    text: `🚨 直近 24 時間で LLM 解析が ${count} 件連続失敗しています。
Anthropic API key の有効性、または Anthropic 側の障害状況を確認してください。`,
  };
}
