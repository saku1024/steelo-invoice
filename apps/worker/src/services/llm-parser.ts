// STEELO Phase 2 F2: LINE メッセージ → dispatch_records 変換サービス。
//
// Queues consumer または Scheduled fallback から呼ばれる。
//
// 流れ:
//   1. line_messages から 1 件取得
//   2. テキスト判定（短文・非テキストはスキップ）
//   3. llm-client.parseDispatchMessage で LLM 呼び出し
//   4. 結果を llm_parse_results に UPSERT
//   5. isDispatch=true なら dispatch_records を 1〜N 件 INSERT
//   6. line_messages.is_parsed / is_dispatch を更新
//
// リトライは Queues 側の retry に任せる（max_retries=3 想定）。
// 4 回失敗時は llm_parse_results.status='failed' のまま is_parsed は更新せず、
// Scheduled fallback で再試行可能にする。
import Anthropic from '@anthropic-ai/sdk';
import {
  getLineMessageById,
  getDriverByLineGroupId,
  upsertLLMParseResult,
  createDispatchRecord,
} from '@line-crm/db';
import {
  CURRENT_PROMPT_VERSION,
  MODEL_NAME,
} from './llm-prompts.js';
import {
  parseDispatchMessage,
  LLMParseError,
  type LLMParseRequest,
  type LLMParseResponse,
} from './llm-client.js';
import { recordSystemAudit } from './audit.js';
import type { Env } from '../index.js';

export interface ParseJobPayload {
  lineMessageId: string;
}

export interface ParserDeps {
  /** 注入可能な LLM クライアント（テスト用） */
  client: Anthropic;
}

export interface ParseJobResult {
  status: 'success' | 'skipped' | 'failed';
  lineMessageId: string;
  isDispatch: boolean;
  dispatchRecordIds: string[];
  errorCode?: string;
  errorMessage?: string;
}

const MIN_TEXT_LENGTH = 10;

export async function handleLLMParseJob(
  env: Env['Bindings'],
  payload: ParseJobPayload,
  deps?: Partial<ParserDeps>
): Promise<ParseJobResult> {
  const lineMessageId = payload.lineMessageId;
  const message = await getLineMessageById(env.DB, lineMessageId);
  if (!message) {
    return {
      status: 'failed',
      lineMessageId,
      isDispatch: false,
      dispatchRecordIds: [],
      errorCode: 'NOT_FOUND',
      errorMessage: 'line_message not found',
    };
  }

  // 短文 / 非テキストはスキップ（コスト削減）
  if (
    message.message_type !== 'text' ||
    !message.message_text ||
    message.message_text.length < MIN_TEXT_LENGTH
  ) {
    await env.DB
      .prepare(`UPDATE line_messages SET is_parsed = 1, is_dispatch = 0 WHERE id = ?`)
      .bind(lineMessageId)
      .run();
    return {
      status: 'skipped',
      lineMessageId,
      isDispatch: false,
      dispatchRecordIds: [],
    };
  }

  // driver hint: line_group_id から解決
  const driver = message.driver_id
    ? null // すでに紐付け済みなら hint 不要
    : await getDriverByLineGroupId(env.DB, message.group_id);
  const driverHint =
    driver !== null && driver !== undefined
      ? { id: driver.id, name: driver.name }
      : message.driver_id
      ? null
      : null;

  // LLM クライアント
  const apiKey = (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  if (!apiKey && !deps?.client) {
    // Workers 環境で API key が無いケース。失敗扱いにする（運用エラー）
    await upsertLLMParseResult(env.DB, {
      lineMessageId,
      modelName: MODEL_NAME,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputJson: JSON.stringify({ text: message.message_text.slice(0, 4000) }),
      outputJson: null,
      status: 'failed',
      errorMessage: 'ANTHROPIC_API_KEY not configured',
      tokenInput: null,
      tokenOutput: null,
      costUsd: null,
    });
    return {
      status: 'failed',
      lineMessageId,
      isDispatch: false,
      dispatchRecordIds: [],
      errorCode: 'AUTH',
      errorMessage: 'ANTHROPIC_API_KEY not configured',
    };
  }
  const client =
    deps?.client ?? new Anthropic({ apiKey: apiKey!, timeout: 30_000 });

  // LLM 呼び出し
  const req: LLMParseRequest = {
    text: message.message_text,
    driverHint,
    receivedAt: message.received_at,
  };
  let resp: LLMParseResponse;
  try {
    resp = await parseDispatchMessage(client, req);
  } catch (e) {
    const isRetryable = e instanceof LLMParseError && e.retryable;
    await upsertLLMParseResult(env.DB, {
      lineMessageId,
      modelName: MODEL_NAME,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputJson: JSON.stringify({ text: message.message_text.slice(0, 4000) }),
      outputJson: null,
      status: 'failed',
      errorMessage: e instanceof Error ? e.message.slice(0, 1000) : String(e),
      tokenInput: null,
      tokenOutput: null,
      costUsd: null,
    });
    // retryable は throw して Queues 側で再試行、それ以外は failed 確定
    if (isRetryable) throw e;
    return {
      status: 'failed',
      lineMessageId,
      isDispatch: false,
      dispatchRecordIds: [],
      errorCode: e instanceof LLMParseError ? e.code : 'UNKNOWN',
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }

  // 結果保存
  await upsertLLMParseResult(env.DB, {
    lineMessageId,
    modelName: resp.modelName,
    promptVersion: resp.promptVersion,
    inputJson: JSON.stringify({ text: message.message_text.slice(0, 4000) }),
    outputJson: resp.rawJson,
    status: 'success',
    errorMessage: null,
    tokenInput: resp.tokenUsage.input,
    tokenOutput: resp.tokenUsage.output,
    costUsd: resp.tokenUsage.costUsd,
  });

  const dispatchIds: string[] = [];
  if (resp.parsed.isDispatch && resp.parsed.records.length > 0) {
    const baseDriverId =
      message.driver_id ?? driverHint?.id ?? null;
    if (baseDriverId) {
      const status =
        resp.parsed.confidence === 'low' ? 'needs_review' : 'auto';
      for (const r of resp.parsed.records) {
        // workDate が無ければ メッセージ受信日（JST）を使う
        const workDate = r.workDate ?? extractDateFromReceivedAt(message.received_at);
        if (!workDate) continue;
        const row = await createDispatchRecord(env.DB, {
          driverId: baseDriverId,
          workDate,
          taskNumber: r.taskNumber ?? null,
          taskName: r.taskName ?? null,
          pickupLocation: r.pickupLocation ?? null,
          deliveryLocation: r.deliveryLocation ?? null,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
          managementNumber: r.managementNumber ?? null,
          rawMessageId: lineMessageId,
          status,
        });
        // confidence は手動で UPDATE（createDispatchRecord に option を増やしてもよい）
        await env.DB
          .prepare(`UPDATE dispatch_records SET confidence = ? WHERE id = ?`)
          .bind(resp.parsed.confidence, row.id)
          .run();
        dispatchIds.push(row.id);
      }
    }
  }

  // line_messages の is_parsed / is_dispatch を更新
  await env.DB
    .prepare(`UPDATE line_messages SET is_parsed = 1, is_dispatch = ? WHERE id = ?`)
    .bind(resp.parsed.isDispatch ? 1 : 0, lineMessageId)
    .run();

  // 監査
  try {
    await recordSystemAudit(env.DB, {
      action: 'llm_parse_request',
      resourceType: 'line_message',
      resourceId: lineMessageId,
      payload: {
        isDispatch: resp.parsed.isDispatch,
        records: resp.parsed.records.length,
        confidence: resp.parsed.confidence,
        tokenUsage: resp.tokenUsage,
        promptVersion: resp.promptVersion,
      },
    });
  } catch (e) {
    console.error('[llm-parser] audit failed:', e);
  }

  return {
    status: 'success',
    lineMessageId,
    isDispatch: resp.parsed.isDispatch,
    dispatchRecordIds: dispatchIds,
  };
}

/** "2026-05-20T10:00:00+09:00" → "2026-05-20" */
function extractDateFromReceivedAt(receivedAt: string): string | null {
  const m = receivedAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
