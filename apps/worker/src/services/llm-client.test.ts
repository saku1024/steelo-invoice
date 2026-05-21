import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { parseDispatchMessage, LLMParseError } from './llm-client.js';

function mockClient(
  response:
    | { content: Array<{ type: 'text'; text: string }>; usage?: { input_tokens: number; output_tokens: number } }
    | Error
): Anthropic {
  const create = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response as unknown as ReturnType<Anthropic['messages']['create']>;
  });
  return { messages: { create } } as unknown as Anthropic;
}

describe('parseDispatchMessage', () => {
  it('正常な JSON 出力をパースして isDispatch=true を返す', async () => {
    const client = mockClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            isDispatch: true,
            confidence: 'high',
            records: [
              {
                driverName: '田中太郎',
                workDate: '2026-05-20',
                taskNumber: 1,
                taskName: '築地チャーター',
                pickupLocation: '東京',
                deliveryLocation: '築地',
                startTime: '06:00',
                endTime: '08:00',
                managementNumber: 'BD-123',
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });
    const r = await parseDispatchMessage(client, {
      text: '田中太郎さん 明日の案件',
      driverHint: null,
      receivedAt: '2026-05-19T22:00:00+09:00',
    });
    expect(r.parsed.isDispatch).toBe(true);
    expect(r.parsed.confidence).toBe('high');
    expect(r.parsed.records).toHaveLength(1);
    expect(r.parsed.records[0].taskName).toBe('築地チャーター');
    expect(r.tokenUsage.input).toBe(500);
    expect(r.tokenUsage.output).toBe(100);
    expect(r.tokenUsage.costUsd).toBeGreaterThan(0);
  });

  it('isDispatch=false の場合 records は空でも OK', async () => {
    const client = mockClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ isDispatch: false, confidence: 'high', records: [] }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const r = await parseDispatchMessage(client, {
      text: 'お疲れさまでした',
      driverHint: null,
      receivedAt: '2026-05-20T18:00:00+09:00',
    });
    expect(r.parsed.isDispatch).toBe(false);
    expect(r.parsed.records).toHaveLength(0);
  });

  it('isDispatch=true で records 空は SCHEMA_MISMATCH', async () => {
    const client = mockClient({
      content: [{ type: 'text', text: JSON.stringify({ isDispatch: true, confidence: 'high', records: [] }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await expect(
      parseDispatchMessage(client, {
        text: 'test',
        driverHint: null,
        receivedAt: '2026-05-20T00:00:00+09:00',
      })
    ).rejects.toBeInstanceOf(LLMParseError);
  });

  it('JSON 不正は INVALID_JSON', async () => {
    const client = mockClient({
      content: [{ type: 'text', text: 'これは JSON ではない' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    try {
      await parseDispatchMessage(client, {
        text: 't',
        driverHint: null,
        receivedAt: '2026-05-20T00:00:00+09:00',
      });
      throw new Error('expected error');
    } catch (e) {
      expect(e).toBeInstanceOf(LLMParseError);
      expect((e as LLMParseError).code).toBe('INVALID_JSON');
    }
  });

  it('confidence が不正値の場合は low に正規化', async () => {
    const client = mockClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            isDispatch: true,
            confidence: 'super',
            records: [{ taskName: 'X', workDate: '2026-05-20' }],
          }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const r = await parseDispatchMessage(client, {
      text: 't',
      driverHint: null,
      receivedAt: '2026-05-20T00:00:00+09:00',
    });
    expect(r.parsed.confidence).toBe('low');
  });

  it('不正な workDate / startTime は null に正規化', async () => {
    const client = mockClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            isDispatch: true,
            confidence: 'high',
            records: [
              {
                taskName: 'X',
                workDate: '2026/05/20', // YYYY-MM-DD ではない
                startTime: '25時',
                endTime: '08:00',
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const r = await parseDispatchMessage(client, {
      text: 't',
      driverHint: null,
      receivedAt: '2026-05-20T00:00:00+09:00',
    });
    expect(r.parsed.records[0].workDate).toBeNull();
    expect(r.parsed.records[0].startTime).toBeNull();
    expect(r.parsed.records[0].endTime).toBe('08:00');
  });
});
