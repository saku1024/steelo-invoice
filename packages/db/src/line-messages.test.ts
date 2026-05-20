import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDriver } from './drivers.js';
import {
  insertLineMessageIgnoreDup,
  listLineMessages,
  getLineMessageById,
} from './line-messages.js';
import { createSqliteD1, type SqliteD1 } from './test-helpers/sqlite-d1.js';

let h: SqliteD1;

beforeEach(() => {
  h = createSqliteD1();
});

afterEach(() => {
  h.close();
});

describe('insertLineMessageIgnoreDup', () => {
  it('同 message_id の二度目 INSERT は冪等（行数は増えない）', async () => {
    const first = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G1',
      messageId: 'mid-1',
      messageType: 'text',
      messageText: 'hello',
      receivedAt: '2026-05-20T10:00:00+09:00',
    });
    expect(first.inserted).toBe(true);

    const second = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G1',
      messageId: 'mid-1',
      messageType: 'text',
      messageText: 'hello',
      receivedAt: '2026-05-20T10:00:01+09:00',
    });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const count = (
      await h.db.prepare(`SELECT COUNT(*) AS n FROM line_messages`).bind().first<{ n: number }>()
    )!.n;
    expect(count).toBe(1);
  });

  it('driver_id と sender 系を含めて保存できる', async () => {
    const d = await createDriver(h.db, { name: 'A', lineGroupId: 'G_a' });
    const r = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_a',
      driverId: d.id,
      senderUserId: 'U123',
      senderName: '田中太郎',
      messageId: 'mid-2',
      messageType: 'text',
      messageText: 'おはよう',
    });
    const row = await getLineMessageById(h.db, r.id);
    expect(row!.driver_id).toBe(d.id);
    expect(row!.sender_user_id).toBe('U123');
    expect(row!.message_type).toBe('text');
  });

  it('image/file 系はメタデータのみ（message_text null）でも保存できる', async () => {
    const r = await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G1',
      messageId: 'mid-3',
      messageType: 'image',
    });
    const row = await getLineMessageById(h.db, r.id);
    expect(row!.message_text).toBeNull();
    expect(row!.message_type).toBe('image');
  });
});

describe('listLineMessages', () => {
  it('受信日時降順、driver/期間/type で絞れる', async () => {
    const d1 = await createDriver(h.db, { name: 'A', lineGroupId: 'G1' });
    await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G1',
      driverId: d1.id,
      messageId: 'm1',
      messageType: 'text',
      receivedAt: '2026-05-20T10:00:00+09:00',
    });
    await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G1',
      driverId: d1.id,
      messageId: 'm2',
      messageType: 'image',
      receivedAt: '2026-05-21T10:00:00+09:00',
    });
    await insertLineMessageIgnoreDup(h.db, {
      groupId: 'G_other',
      messageId: 'm3',
      messageType: 'text',
      receivedAt: '2026-05-22T10:00:00+09:00',
    });

    const all = await listLineMessages(h.db);
    expect(all.total).toBe(3);
    expect(all.items[0].message_id).toBe('m3'); // 降順

    const byDriver = await listLineMessages(h.db, { driverId: d1.id });
    expect(byDriver.total).toBe(2);

    const onlyImg = await listLineMessages(h.db, { messageType: 'image' });
    expect(onlyImg.total).toBe(1);
    expect(onlyImg.items[0].message_id).toBe('m2');

    const ranged = await listLineMessages(h.db, {
      from: '2026-05-21T00:00:00+09:00',
      to: '2026-05-21T23:59:59+09:00',
    });
    expect(ranged.total).toBe(1);
    expect(ranged.items[0].message_id).toBe('m2');
  });
});
