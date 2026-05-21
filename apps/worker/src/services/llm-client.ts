// STEELO Phase 2 F2: Anthropic Claude Haiku ラッパー。
//
// - prompt caching を有効化し、共通 system プロンプトのコストを抑える
// - tokenUsage と costUsd を返して llm_parse_results に保存する
// - timeout 30s、上位の llm-parser でリトライ
//
// テスト容易性のため、Anthropic クライアント自体は依存性注入できる。
import Anthropic from '@anthropic-ai/sdk';
import type { LLMDispatchRecord, LLMParseOutput } from '@line-crm/shared';
import {
  CURRENT_PROMPT_VERSION,
  MODEL_NAME,
  buildUserPrompt,
  estimateCostUsd,
  getPromptBundle,
} from './llm-prompts.js';
import { isCalendarValidDate, isCalendarValidTime } from './date-validation.js';

export interface LLMParseRequest {
  text: string;
  driverHint: { id: string; name: string } | null;
  receivedAt: string;
  promptVersion?: number;
}

export interface LLMParseResponse {
  parsed: LLMParseOutput;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
  };
  rawJson: string;
  promptVersion: number;
  modelName: string;
}

export class LLMParseError extends Error {
  constructor(
    public code:
      | 'TIMEOUT'
      | 'RATE_LIMIT'
      | 'AUTH'
      | 'NETWORK'
      | 'INVALID_JSON'
      | 'SCHEMA_MISMATCH'
      | 'UNKNOWN',
    message: string,
    public retryable: boolean,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'LLMParseError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 1024;

/**
 * Anthropic Claude Haiku で 1 LINE メッセージを解析し、構造化された
 * dispatch records を返す。
 *
 * @param client Anthropic クライアント（テストでモック注入可能）
 * @param req 解析対象メッセージとコンテキスト
 */
export async function parseDispatchMessage(
  client: Anthropic,
  req: LLMParseRequest
): Promise<LLMParseResponse> {
  const version = req.promptVersion ?? CURRENT_PROMPT_VERSION;
  const bundle = getPromptBundle(version);
  const userPrompt = buildUserPrompt(
    req.text,
    req.driverHint ? { name: req.driverHint.name } : null,
    req.receivedAt
  );

  let resp;
  try {
    resp = await client.messages.create(
      {
        model: bundle.modelName,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          {
            type: 'text',
            text: bundle.systemPrompt,
            // prompt caching: 同じ system プロンプトを 5 分キャッシュ
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (e) {
    throw mapAnthropicError(e);
  }

  // Codex Phase 2 review MEDIUM #14 反映:
  // usage は input_tokens + cache_creation_input_tokens + cache_read_input_tokens を
  // 合算する。各 token に単価が違うので個別に保持して costUsd 計算でも反映する。
  const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead =
    (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheWrite =
    (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;

  // content[0].text を取り出す（text タイプのみ想定）
  const rawJson = extractText(resp.content);
  if (!rawJson) {
    throw new LLMParseError('SCHEMA_MISMATCH', 'no text content in response', false);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch (e) {
    throw new LLMParseError(
      'INVALID_JSON',
      `JSON parse failed: ${String(e)}; raw=${rawJson.slice(0, 200)}`,
      false
    );
  }

  const parsed = validateOutput(parsedJson);

  return {
    parsed,
    tokenUsage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      costUsd: estimateCostUsd(input, output, cacheRead, cacheWrite),
    },
    rawJson,
    promptVersion: bundle.version,
    modelName: MODEL_NAME,
  };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}

function mapAnthropicError(e: unknown): LLMParseError {
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new LLMParseError('TIMEOUT', 'request timed out', true);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new LLMParseError('NETWORK', String(e.message), true);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new LLMParseError('RATE_LIMIT', String(e.message), true, 429);
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return new LLMParseError('AUTH', String(e.message), false, 401);
  }
  if (e instanceof Anthropic.APIError) {
    // 5xx は再試行可能
    const retry = e.status !== undefined && e.status >= 500;
    return new LLMParseError(
      retry ? 'NETWORK' : 'UNKNOWN',
      String(e.message),
      retry,
      e.status
    );
  }
  return new LLMParseError('UNKNOWN', String(e), false);
}

/** LLM 出力の必須フィールドを検証し、形式を揃える */
function validateOutput(raw: unknown): LLMParseOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new LLMParseError('SCHEMA_MISMATCH', 'output is not an object', false);
  }
  const obj = raw as Record<string, unknown>;
  const isDispatch = obj.isDispatch === true;
  const confidence = obj.confidence;
  const conf =
    confidence === 'high' || confidence === 'medium' || confidence === 'low'
      ? confidence
      : 'low';

  const records: LLMDispatchRecord[] = [];
  if (Array.isArray(obj.records)) {
    for (const r of obj.records as Record<string, unknown>[]) {
      if (typeof r !== 'object' || r === null) continue;
      records.push({
        driverName: nullableString(r.driverName),
        workDate: validateDate(r.workDate),
        taskNumber: nullableInt(r.taskNumber),
        taskName: nullableString(r.taskName),
        pickupLocation: nullableString(r.pickupLocation),
        deliveryLocation: nullableString(r.deliveryLocation),
        startTime: validateTime(r.startTime),
        endTime: validateTime(r.endTime),
        managementNumber: nullableString(r.managementNumber),
      });
    }
  }
  if (isDispatch && records.length === 0) {
    throw new LLMParseError(
      'SCHEMA_MISMATCH',
      'isDispatch=true but records is empty',
      false
    );
  }

  return {
    isDispatch,
    confidence: conf,
    records,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
  };
}

function nullableString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, 500);
}

function nullableInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return Math.round(n);
  }
  return null;
}

function validateDate(v: unknown): string | null {
  // Codex Phase 2 review MEDIUM #13: 2026-02-31 のようなカレンダー無効値を弾く
  return typeof v === 'string' && isCalendarValidDate(v) ? v : null;
}

function validateTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return isCalendarValidTime(t) ? t : null;
}

/** Factory: Workers 環境で Anthropic クライアントを作る */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
}
