// STEELO Phase 2: llm_parse_results のクエリ関数
import { jstNow } from './utils.js';

export interface LLMParseResultRow {
  id: string;
  line_message_id: string;
  model_name: string;
  prompt_version: number;
  input_json: string;
  output_json: string | null;
  status: string;
  error_message: string | null;
  token_input: number | null;
  token_output: number | null;
  cost_usd: number | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertLLMParseInput {
  lineMessageId: string;
  modelName: string;
  promptVersion: number;
  inputJson: string;
  outputJson: string | null;
  status: 'success' | 'failed' | 'pending';
  errorMessage: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  costUsd: number | null;
}

/**
 * line_message_id UNIQUE のため UPSERT 動作: 既存があれば UPDATE、attempt_count++。
 */
export async function upsertLLMParseResult(
  db: D1Database,
  input: UpsertLLMParseInput
): Promise<LLMParseResultRow> {
  const existing = await db
    .prepare(`SELECT * FROM llm_parse_results WHERE line_message_id = ?`)
    .bind(input.lineMessageId)
    .first<LLMParseResultRow>();
  const now = jstNow();
  if (existing) {
    await db
      .prepare(
        `UPDATE llm_parse_results SET
           model_name = ?, prompt_version = ?, input_json = ?, output_json = ?,
           status = ?, error_message = ?,
           token_input = ?, token_output = ?, cost_usd = ?,
           attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        input.modelName,
        input.promptVersion,
        input.inputJson,
        input.outputJson,
        input.status,
        input.errorMessage,
        input.tokenInput,
        input.tokenOutput,
        input.costUsd,
        now,
        existing.id
      )
      .run();
    return (await getLLMParseResultByMessage(db, input.lineMessageId))!;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO llm_parse_results
       (id, line_message_id, model_name, prompt_version, input_json, output_json,
        status, error_message, token_input, token_output, cost_usd, attempt_count,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      id,
      input.lineMessageId,
      input.modelName,
      input.promptVersion,
      input.inputJson,
      input.outputJson,
      input.status,
      input.errorMessage,
      input.tokenInput,
      input.tokenOutput,
      input.costUsd,
      now,
      now
    )
    .run();
  return (await getLLMParseResultByMessage(db, input.lineMessageId))!;
}

export async function getLLMParseResultByMessage(
  db: D1Database,
  lineMessageId: string
): Promise<LLMParseResultRow | null> {
  return db
    .prepare(`SELECT * FROM llm_parse_results WHERE line_message_id = ?`)
    .bind(lineMessageId)
    .first<LLMParseResultRow>();
}

export interface LLMStatsRow {
  total: number;
  success: number;
  failed: number;
  token_input_sum: number;
  token_output_sum: number;
  cost_usd_sum: number;
}

export async function getLLMStats(
  db: D1Database,
  opts: { from?: string; to?: string } = {}
): Promise<LLMStatsRow> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.from) {
    where.push('created_at >= ?');
    vals.push(opts.from);
  }
  if (opts.to) {
    where.push('created_at <= ?');
    vals.push(opts.to);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(token_input), 0) AS token_input_sum,
         COALESCE(SUM(token_output), 0) AS token_output_sum,
         COALESCE(SUM(cost_usd), 0) AS cost_usd_sum
       FROM llm_parse_results ${w}`
    )
    .bind(...vals)
    .first<LLMStatsRow>();
  // SQLite では行は必ず返るが null safety で fallback
  return {
    total: r?.total ?? 0,
    success: r?.success ?? 0,
    failed: r?.failed ?? 0,
    token_input_sum: r?.token_input_sum ?? 0,
    token_output_sum: r?.token_output_sum ?? 0,
    cost_usd_sum: r?.cost_usd_sum ?? 0,
  };
}

/** 解析未済のメッセージを最大 limit 件返す（Scheduled fallback 用） */
export async function listUnparsedLineMessageIds(
  db: D1Database,
  limit = 50
): Promise<string[]> {
  const r = await db
    .prepare(
      `SELECT m.id FROM line_messages m
       LEFT JOIN llm_parse_results lpr ON lpr.line_message_id = m.id
       WHERE m.is_parsed = 0
         AND m.message_type = 'text'
         AND LENGTH(COALESCE(m.message_text, '')) >= 10
         AND (lpr.id IS NULL OR lpr.status = 'failed')
       ORDER BY m.received_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ id: string }>();
  return r.results.map((row) => row.id);
}
