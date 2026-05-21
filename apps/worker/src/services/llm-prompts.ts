// STEELO Phase 2 F2: LLM 解析用システムプロンプトのバージョン管理。
//
// プロンプトを変更したら必ず CURRENT_PROMPT_VERSION を bump する。
// llm_parse_results.prompt_version に保存されるので、後から精度回帰を追える。
//
// メッセージ本文（個人情報を含む可能性）はプロンプトには含めない。
// 配車パターンの例だけを load する。Anthropic prompt caching が効くよう、
// system プロンプトは静的に固定する。

/**
 * prompt 内容（system + user 構造）のバージョン番号。プロンプト本体を変えたら bump する。
 * モデル ID 自体は MODEL_NAME で別管理しているので、モデル切替だけでは bump しない。
 */
export const CURRENT_PROMPT_VERSION = 1;

/**
 * Claude Haiku 4.5 — エイリアスを使用（Anthropic スキルガイドの推奨）。
 * 旧 claude-3-haiku-20240307 は 2026-04-20 に retired したため使えない。
 * Anthropic は date-stamped ID への append を推奨しないため、エイリアス固定。
 */
export const MODEL_NAME = 'claude-haiku-4-5';

/**
 * 概算コスト（Claude Haiku 4.5 価格、2026 時点）:
 *   input: $1.00 / 1M tokens、output: $5.00 / 1M tokens
 *
 * 月 1,000 件 × 平均 600 input + 200 output tokens
 *   = 600,000 input + 200,000 output → $0.60 + $1.00 = $1.60
 *   ≒ ¥240
 *
 * 注: prompt cache は **Haiku 4.5 では system プロンプトが 4096 tokens 未満**
 * のため silent no-op になる（claude-api スキル指摘 #A）。
 * cache_control は今後プロンプトを拡張した時のために残してある。
 * 4096 tokens 超を保証したい場合は few-shot 例を増やすこと。
 */
export const PRICE_INPUT_PER_M_TOKENS_USD = 1.0;
export const PRICE_OUTPUT_PER_M_TOKENS_USD = 5.0;
/** cache_read は input の 10%、cache_creation は input の 1.25 倍 */
export const PRICE_CACHE_READ_PER_M_TOKENS_USD = 0.1;
export const PRICE_CACHE_WRITE_PER_M_TOKENS_USD = 1.25;

export function estimateCostUsd(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0
): number {
  return (
    (input / 1_000_000) * PRICE_INPUT_PER_M_TOKENS_USD +
    (output / 1_000_000) * PRICE_OUTPUT_PER_M_TOKENS_USD +
    (cacheRead / 1_000_000) * PRICE_CACHE_READ_PER_M_TOKENS_USD +
    (cacheWrite / 1_000_000) * PRICE_CACHE_WRITE_PER_M_TOKENS_USD
  );
}

export interface PromptBundle {
  version: number;
  modelName: string;
  systemPrompt: string;
  jsonSchemaHint: string;
}

// claude-api スキル指摘 #B 反映:
//   structured outputs (output_config.format + json_schema) を使うようになったため、
//   プロンプトから「JSON のみ出力」「フォーマット例」を削除し、判定ロジックの
//   説明に絞り込んだ。フォーマット保証は API レイヤー側 (schema) が行う。
const SYSTEM_PROMPT_V1 = `あなたは運送業 STEELO の配車管理アシスタントです。
LINE グループに流れたテキストメッセージを受け取り、それが「配車案内」かどうかを判定し、
配車案内の場合は構造化された案件情報を返してください。

# 配車案内の典型パターン

元請け（BOND's）からドライバーに送られる配車メッセージは、おおむね以下の構造です:

\`\`\`
{ドライバー名}さん
お疲れ様です。
明日の案件詳細です。

※明日は{N}案件まであります。
※自発時間お知らせください。

①{業務名}
{時刻} {場所} 集荷
→{時刻}〜{時刻} {場所} 行き
動態管理番号→{番号}

②{業務名}
...
\`\`\`

ただし定型ではないバリエーションも多いので、業務名・時刻・場所の文脈で判断してください。
「配車案内」以外のもの（完了報告、雑談、画像共有等）は isDispatch=false を返してください。

# 抽出するフィールド

各案件について以下を抽出（不明なら null）:
- driverName: 宛先のドライバー名（"{name}さん" 等から）
- workDate: 作業日 "YYYY-MM-DD"（メッセージ受信日や「明日」等から推定）
- taskNumber: 案件番号 1, 2, 3...（①②③ から）
- taskName: 業務名（"築地チャーター" 等）
- pickupLocation: 集荷先
- deliveryLocation: 納品先
- startTime: 開始時刻 "HH:MM"
- endTime: 終了時刻 "HH:MM"（範囲があれば末尾）
- managementNumber: 動態管理番号

# confidence ルール

- 全ての案件で業務名・時刻ともに取れていれば "high"
- 業務名と時刻のどちらかが欠落している案件があれば "low"
- 上記の中間（一部完全、一部 partial）は "medium"

# 出力

isDispatch=false のときは records は [] にする。`;

// claude-api スキル指摘 #B 反映:
//   Anthropic structured outputs に渡す JSON Schema。Haiku 4.5 は対応モデル。
//   strict: additionalProperties=false が要求されるので各オブジェクトで明示する。
//   minimum/maximum/minLength/maxLength は未サポートなので使わない。
//   recursive schema も未サポートなので flat な型のみ。
const OUTPUT_SCHEMA_V1 = {
  type: 'object',
  additionalProperties: false,
  required: ['isDispatch', 'confidence', 'records'],
  properties: {
    isDispatch: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    records: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'driverName',
          'workDate',
          'taskNumber',
          'taskName',
          'pickupLocation',
          'deliveryLocation',
          'startTime',
          'endTime',
          'managementNumber',
        ],
        properties: {
          driverName: { type: ['string', 'null'] },
          workDate: { type: ['string', 'null'] },
          taskNumber: { type: ['integer', 'null'] },
          taskName: { type: ['string', 'null'] },
          pickupLocation: { type: ['string', 'null'] },
          deliveryLocation: { type: ['string', 'null'] },
          startTime: { type: ['string', 'null'] },
          endTime: { type: ['string', 'null'] },
          managementNumber: { type: ['string', 'null'] },
        },
      },
    },
    reasoning: { type: 'string' },
  },
} as const;

export type OutputSchema = typeof OUTPUT_SCHEMA_V1;

export function getOutputSchema(version: number = CURRENT_PROMPT_VERSION): unknown {
  if (version === 1) return OUTPUT_SCHEMA_V1;
  throw new Error(`unknown prompt version: ${version}`);
}

/** @deprecated structured outputs を使うため未使用。互換のため残す。 */
const JSON_SCHEMA_HINT_V1 = JSON.stringify(OUTPUT_SCHEMA_V1);

/** バージョン番号からプロンプトを取得する。version は履歴のキー */
export function getPromptBundle(version: number = CURRENT_PROMPT_VERSION): PromptBundle {
  if (version === 1) {
    return {
      version: 1,
      modelName: MODEL_NAME,
      systemPrompt: SYSTEM_PROMPT_V1,
      jsonSchemaHint: JSON_SCHEMA_HINT_V1,
    };
  }
  throw new Error(`unknown prompt version: ${version}`);
}

/**
 * system prompt の SHA-256 ハッシュ短縮版（先頭 12 文字）を返す。
 * llm_parse_results.input_json に保存して、プロンプト改変の検証に使う
 * （Codex Phase 2 review MEDIUM #15 反映）。
 */
export async function computeSystemPromptHash(version: number = CURRENT_PROMPT_VERSION): Promise<string> {
  const bundle = getPromptBundle(version);
  const data = new TextEncoder().encode(bundle.systemPrompt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 解析対象メッセージから user prompt を組み立てる。driverHint があれば
 * 文脈として埋める（system プロンプト側には PII を入れない）。
 * 出力フォーマットは output_config.format で API が保証するので、
 * プロンプトでの強制は不要 (claude-api スキル指摘 #B)。
 */
export function buildUserPrompt(
  messageText: string,
  driverHint: { name: string } | null,
  receivedAt: string
): string {
  const hint = driverHint
    ? `\n[配車先のドライバー候補] ${driverHint.name}\n`
    : '';
  return `次の LINE メッセージを解析してください。
[受信日時] ${receivedAt}${hint}

[本文]
${messageText}`;
}
