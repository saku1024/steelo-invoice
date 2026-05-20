import { Hono } from 'hono';
import {
  listLineMessages,
  getLineMessageById,
  type LineMessageRow,
} from '@line-crm/db';
import type { LineMessage } from '@line-crm/shared';
import type { Env } from '../index.js';

const lineMessages = new Hono<Env>();

function serialize(r: LineMessageRow): LineMessage {
  return {
    id: r.id,
    groupId: r.group_id,
    driverId: r.driver_id,
    senderUserId: r.sender_user_id,
    senderName: r.sender_name,
    messageId: r.message_id,
    messageType: r.message_type as LineMessage['messageType'],
    messageText: r.message_text,
    isDispatch: Boolean(r.is_dispatch),
    isParsed: Boolean(r.is_parsed),
    receivedAt: r.received_at,
    createdAt: r.created_at,
  };
}

lineMessages.get('/api/line-messages', async (c) => {
  try {
    const limitRaw = c.req.query('limit');
    const offsetRaw = c.req.query('offset');
    const result = await listLineMessages(c.env.DB, {
      driverId: c.req.query('driver_id') ?? undefined,
      groupId: c.req.query('group_id') ?? undefined,
      from: c.req.query('from') ?? undefined,
      to: c.req.query('to') ?? undefined,
      messageType: c.req.query('type') ?? undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
      offset: offsetRaw ? Number(offsetRaw) : undefined,
    });
    return c.json({
      success: true,
      data: { items: result.items.map(serialize), total: result.total },
    });
  } catch (err) {
    console.error('GET /api/line-messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

lineMessages.get('/api/line-messages/:id', async (c) => {
  try {
    const row = await getLineMessageById(c.env.DB, c.req.param('id'));
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error('GET /api/line-messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default lineMessages;
