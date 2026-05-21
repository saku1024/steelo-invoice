import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendDeliveryViaLine, buildMessages } from './line-notifier.js';

describe('buildMessages', () => {
  it('reconciliation_completed: 件数 + warning + URL を含む text を組み立て', () => {
    const messages = buildMessages({
      id: 'd-1',
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      payloadSchemaVer: 1,
      eventPayloadJson: JSON.stringify({
        period: '2026-05',
        matched: 87,
        clientOnly: 3,
        dispatchOnly: 2,
        warningCounts: { fare_deviation_high: 2, time_inversion: 1 },
        adminUrl: 'https://admin.example.com/reconciliations?period=2026-05',
      }),
      attemptCount: 0,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    const text = messages[0].text!;
    expect(text).toContain('2026-05');
    expect(text).toContain('matched: 87');
    expect(text).toContain('fare_deviation_high 2 件');
    expect(text).toContain('https://admin.example.com');
  });

  it('monthly_reminder: 前月名を含む text', () => {
    const messages = buildMessages({
      id: 'd-1',
      idempotencyKey: 'k1',
      eventType: 'monthly_reminder',
      payloadSchemaVer: 1,
      eventPayloadJson: JSON.stringify({ prevPeriod: '2026-04' }),
      attemptCount: 0,
    });
    expect(messages[0].text).toContain('2026-04');
    expect(messages[0].text).toContain('元請け Excel');
  });

  it('llm_parse_failed_streak: 件数を含む text', () => {
    const messages = buildMessages({
      id: 'd-1',
      idempotencyKey: 'k1',
      eventType: 'llm_parse_failed_streak',
      payloadSchemaVer: 1,
      eventPayloadJson: JSON.stringify({ count: 8 }),
      attemptCount: 0,
    });
    expect(messages[0].text).toContain('8 件連続失敗');
  });

  it('未知の payload_schema_ver は警告 text', () => {
    const messages = buildMessages({
      id: 'd-1',
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      payloadSchemaVer: 99,
      eventPayloadJson: '{}',
      attemptCount: 0,
    });
    expect(messages[0].text).toContain('ver=99');
  });

  it('payload JSON 不正は警告 text', () => {
    const messages = buildMessages({
      id: 'd-1',
      idempotencyKey: 'k1',
      eventType: 'reconciliation_completed',
      payloadSchemaVer: 1,
      eventPayloadJson: 'not json',
      attemptCount: 0,
    });
    expect(messages[0].text).toContain('payload parse error');
  });
});

describe('sendDeliveryViaLine', () => {
  const baseJob = {
    id: 'd-1',
    idempotencyKey: 'k1',
    eventType: 'reconciliation_completed' as const,
    payloadSchemaVer: 1,
    eventPayloadJson: JSON.stringify({
      period: '2026-05',
      matched: 1,
      clientOnly: 0,
      dispatchOnly: 0,
      warningCounts: {},
      adminUrl: '',
    }),
    attemptCount: 0,
  };

  const fastSleep = () => Promise.resolve();

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('200 OK → sent: true で 1 回の fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200 }),
    );
    const r = await sendDeliveryViaLine(baseJob, {
      channelAccessToken: 'tok',
      targetId: 'U1234567890abcdef1234567890abcdef',
      sleep: fastSleep,
    });
    expect(r.sent).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4xx は即 failed (retryable=false)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"message":"invalid token"}', { status: 401 }),
    );
    const r = await sendDeliveryViaLine(baseJob, {
      channelAccessToken: 'tok',
      targetId: 'U1234567890abcdef1234567890abcdef',
      sleep: fastSleep,
    });
    expect(r.sent).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.httpStatus).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx は retry し、最後まで失敗で retryable=true', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"message":"server error"}', { status: 503 }),
    );
    const r = await sendDeliveryViaLine(baseJob, {
      channelAccessToken: 'tok',
      targetId: 'U1234567890abcdef1234567890abcdef',
      sleep: fastSleep,
    });
    expect(r.sent).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.httpStatus).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('5xx 後に 200 に回復したら sent: true', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const r = await sendDeliveryViaLine(baseJob, {
      channelAccessToken: 'tok',
      targetId: 'U1234567890abcdef1234567890abcdef',
      sleep: fastSleep,
    });
    expect(r.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetch timeout (AbortError) は retryable', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const r = await sendDeliveryViaLine(baseJob, {
      channelAccessToken: 'tok',
      targetId: 'U1234567890abcdef1234567890abcdef',
      sleep: fastSleep,
    });
    expect(r.sent).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.error).toContain('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
