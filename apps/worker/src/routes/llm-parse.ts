import { Hono } from 'hono';
import {
  getLineMessageById,
  getLLMParseResultByMessage,
  getLLMStats,
} from '@line-crm/db';
import { handleLLMParseJob } from '../services/llm-parser.js';
import { safeAudit } from '../services/audit.js';
import type { Env } from '../index.js';

const llmParse = new Hono<Env>();

llmParse.post('/api/llm-parse/messages/:id/reparse', async (c) => {
  try {
    const lineMessageId = c.req.param('id');
    const message = await getLineMessageById(c.env.DB, lineMessageId);
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);
    // is_parsed をリセットして再解析
    await c.env.DB
      .prepare(`UPDATE line_messages SET is_parsed = 0 WHERE id = ?`)
      .bind(lineMessageId)
      .run();
    const result = await handleLLMParseJob(c.env, { lineMessageId });
    await safeAudit(c.env.DB, c, {
      action: 'llm_parse_reparse',
      resourceType: 'line_message',
      resourceId: lineMessageId,
      payload: { status: result.status, isDispatch: result.isDispatch, dispatchIds: result.dispatchRecordIds },
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/llm-parse/messages/:id/reparse error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

llmParse.get('/api/llm-parse/results/:messageId', async (c) => {
  try {
    const row = await getLLMParseResultByMessage(c.env.DB, c.req.param('messageId'));
    if (!row) return c.json({ success: false, error: 'no parse result' }, 404);
    return c.json({
      success: true,
      data: {
        id: row.id,
        lineMessageId: row.line_message_id,
        modelName: row.model_name,
        promptVersion: row.prompt_version,
        status: row.status,
        errorMessage: row.error_message,
        tokenInput: row.token_input,
        tokenOutput: row.token_output,
        costUsd: row.cost_usd,
        attemptCount: row.attempt_count,
        outputJson: row.output_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    console.error('GET /api/llm-parse/results/:messageId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

llmParse.get('/api/llm-parse/stats', async (c) => {
  try {
    const from = c.req.query('from') ?? undefined;
    const to = c.req.query('to') ?? undefined;
    const stats = await getLLMStats(c.env.DB, { from, to });
    return c.json({
      success: true,
      data: {
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
        successRate: stats.total > 0 ? stats.success / stats.total : 0,
        tokenInputSum: stats.token_input_sum,
        tokenOutputSum: stats.token_output_sum,
        costUsdSum: stats.cost_usd_sum,
      },
    });
  } catch (err) {
    console.error('GET /api/llm-parse/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default llmParse;
