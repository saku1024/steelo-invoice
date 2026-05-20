import { describe, it, expect, vi } from 'vitest';
import { handleGroupMessage, isGroupMessageEvent } from './group-message-handler.js';
import type { WebhookEvent } from '@line-crm/line-sdk';

vi.mock('@line-crm/db', async () => {
  const drivers = new Map<string, { id: string; name: string; line_group_id: string }>();
  const messages: unknown[] = [];
  return {
    getDriverByLineGroupId: vi.fn(async (_db: unknown, gid: string) =>
      drivers.get(gid) ?? null
    ),
    insertLineMessageIgnoreDup: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      messages.push(input);
      return { inserted: true, id: 'msg-1' };
    }),
    __setDriver: (driver: { id: string; name: string; line_group_id: string }) =>
      drivers.set(driver.line_group_id, driver),
    __messages: messages,
    __reset: () => {
      drivers.clear();
      messages.length = 0;
    },
  };
});

const db = {} as D1Database;

function makeMessageEvent(opts: {
  groupId: string;
  type?: 'text' | 'image' | 'file' | 'video' | 'audio' | 'sticker';
  text?: string;
  userId?: string;
}): WebhookEvent {
  return {
    type: 'message',
    source: {
      type: 'group',
      groupId: opts.groupId,
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    timestamp: Date.parse('2026-05-20T01:00:00Z'),
    replyToken: 'rt',
    message: {
      id: 'mid-1',
      type: opts.type ?? 'text',
      ...(opts.type === 'text' || !opts.type ? { text: opts.text ?? 'hello' } : {}),
    } as never,
  } as unknown as WebhookEvent;
}

describe('isGroupMessageEvent', () => {
  it('group message のときだけ true', () => {
    expect(isGroupMessageEvent(makeMessageEvent({ groupId: 'G1' }))).toBe(true);
    const userEvent = { ...makeMessageEvent({ groupId: 'G1' }) } as { source: { type: string } };
    userEvent.source = { type: 'user' };
    expect(isGroupMessageEvent(userEvent as unknown as WebhookEvent)).toBe(false);
  });
});

describe('handleGroupMessage', () => {
  it('未登録グループでも driver_id=null で保存される', async () => {
    const dbMod = await import('@line-crm/db');
    (dbMod as unknown as { __reset: () => void }).__reset();
    await handleGroupMessage(db, makeMessageEvent({ groupId: 'G_unknown', userId: 'U1' }));
    const messages = (dbMod as unknown as { __messages: { driverId: unknown; messageType: string }[] })
      .__messages;
    expect(messages.length).toBe(1);
    expect(messages[0].driverId).toBeNull();
  });

  it('登録済みグループは driver_id が紐付く', async () => {
    const dbMod = await import('@line-crm/db');
    (dbMod as unknown as { __reset: () => void; __setDriver: (d: unknown) => void }).__reset();
    (dbMod as unknown as { __setDriver: (d: unknown) => void }).__setDriver({
      id: 'd-1',
      name: 'A',
      line_group_id: 'G_a',
    });
    await handleGroupMessage(db, makeMessageEvent({ groupId: 'G_a' }));
    const messages = (dbMod as unknown as { __messages: { driverId: unknown }[] }).__messages;
    expect(messages[0].driverId).toBe('d-1');
  });

  it('image/file 等のバイナリ系はメタデータのみ保存', async () => {
    const dbMod = await import('@line-crm/db');
    (dbMod as unknown as { __reset: () => void }).__reset();
    await handleGroupMessage(db, makeMessageEvent({ groupId: 'G_a', type: 'image' }));
    const messages = (dbMod as unknown as { __messages: { messageType: string; messageText: unknown }[] })
      .__messages;
    expect(messages[0].messageType).toBe('image');
    expect(messages[0].messageText).toBeNull();
  });

  it('group 以外の event は無視（INSERT されない）', async () => {
    const dbMod = await import('@line-crm/db');
    (dbMod as unknown as { __reset: () => void }).__reset();
    const userMsg = { ...makeMessageEvent({ groupId: 'G' }) } as { source: { type: string } };
    userMsg.source = { type: 'user' };
    await handleGroupMessage(db, userMsg as unknown as WebhookEvent);
    const messages = (dbMod as unknown as { __messages: unknown[] }).__messages;
    expect(messages.length).toBe(0);
  });
});
