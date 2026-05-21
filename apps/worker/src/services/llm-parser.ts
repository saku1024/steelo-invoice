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
  deleteDispatchRecordsByRawMessageId,
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

  // 結果保存（input は再解析できる程度に保持: prompt version + driver hint 等）
  const inputSnapshot = JSON.stringify({
    text: message.message_text.slice(0, 4000),
    receivedAt: message.received_at,
    promptVersion: resp.promptVersion,
    driverHint: driverHint ? { id: driverHint.id, name: driverHint.name } : null,
  });
  await upsertLLMParseResult(env.DB, {
    lineMessageId,
    modelName: resp.modelName,
    promptVersion: resp.promptVersion,
    inputJson: inputSnapshot,
    outputJson: resp.rawJson,
    status: 'success',
    errorMessage: null,
    tokenInput: resp.tokenUsage.input,
    tokenOutput: resp.tokenUsage.output,
    costUsd: resp.tokenUsage.costUsd,
  });

  // Codex Phase 2 review CRITICAL #2 反映:
  // 同 line_message から作られた auto/needs_review の dispatch_records を一度削除し、
  // 重複生成を防ぐ。confirmed 状態のレコードは保護。
  await deleteDispatchRecordsByRawMessageId(env.DB, lineMessageId);

  const dispatchIds: string[] = [];
  // Codex Phase 2 review HIGH #7 反映:
  // driver 未解決でも isDispatch=true なら is_parsed=0 のまま needs_review に残し、
  // 運用者が driver_alias を追加して再 parse できるようにする。
  if (resp.parsed.isDispatch) {
    const baseDriverId =
      message.driver_id ?? driverHint?.id ?? null;
    if (baseDriverId && resp.parsed.records.length > 0) {
      for (const r of resp.parsed.records) {
        // Codex Phase 2 review MEDIUM #12 反映:
        // workDate 欠落は補完せず needs_review に倒す（受信日とは別日の可能性が
        // 「明日の案件」では当たり前のため）
        if (!r.workDate) {
          // workDate 無い records は status='needs_review' でメタデータのみ保存
          const fallbackDate = extractDateFromReceivedAt(message.received_at);
          if (!fallbackDate) continue;
          const row = await createDispatchRecord(env.DB, {
            driverId: baseDriverId,
            workDate: fallbackDate,
            taskNumber: r.taskNumber ?? null,
            taskName: r.taskName ?? null,
            pickupLocation: r.pickupLocation ?? null,
            deliveryLocation: r.deliveryLocation ?? null,
            startTime: r.startTime ?? null,
            endTime: r.endTime ?? null,
            managementNumber: r.managementNumber ?? null,
            rawMessageId: lineMessageId,
            status: 'needs_review',
          });
          await env.DB
            .prepare(`UPDATE dispatch_records SET confidence = ? WHERE id = ?`)
            .bind('low', row.id)
            .run();
          dispatchIds.push(row.id);
          continue;
        }
        // Codex Phase 2 review HIGH #11 反映:
        // 必須フィールド（taskName + startTime のどちらか）が欠落していたら
        // confidence に関わらず needs_review に倒す
        const incomplete = !r.taskName || !r.startTime;
        const status =
          incomplete || resp.parsed.confidence === 'low'
            ? 'needs_review'
            : 'auto';
        const row = await createDispatchRecord(env.DB, {
          driverId: baseDriverId,
          workDate: r.workDate,
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
        // confidence: 不完全なら low、それ以外は LLM の出力に従う
        const effectiveConfidence = incomplete ? 'low' : resp.parsed.confidence;
        await env.DB
          .prepare(`UPDATE dispatch_records SET confidence = ? WHERE id = ?`)
          .bind(effectiveConfidence, row.id)
          .run();
        dispatchIds.push(row.id);
      }
    }
    // driver 未解決 or records=0 で isDispatch=true の場合は line_messages.is_parsed=0
    // のままにして、driver_alias 追加 or 手動 reparse で再試行可能にする
    if (!baseDriverId || resp.parsed.records.length === 0) {
      await env.DB
        .prepare(
          `UPDATE line_messages SET is_dispatch = 1 WHERE id = ?`
        )
        .bind(lineMessageId)
        .run();
    } else {
      await env.DB
        .prepare(
          `UPDATE line_messages SET is_parsed = 1, is_dispatch = 1 WHERE id = ?`
        )
        .bind(lineMessageId)
        .run();
    }
  } else {
    // 非配車メッセージは is_parsed=1, is_dispatch=0 で確定
    await env.DB
      .prepare(`UPDATE line_messages SET is_parsed = 1, is_dispatch = 0 WHERE id = ?`)
      .bind(lineMessageId)
      .run();
  }

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
