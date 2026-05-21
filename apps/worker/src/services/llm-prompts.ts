// STEELO Phase 2 F2: LLM 解析用システムプロンプトのバージョン管理。
//
// プロンプトを変更したら必ず CURRENT_PROMPT_VERSION を bump する。
// llm_parse_results.prompt_version に保存されるので、後から精度回帰を追える。
//
// メッセージ本文（個人情報を含む可能性）はプロンプトには含めない。
// 配車パターンの例だけを load する。Anthropic prompt caching が効くよう、
// system プロンプトは静的に固定する。

export const CURRENT_PROMPT_VERSION = 1;

export const MODEL_NAME = 'claude-3-haiku-20240307';

/**
 * 概算コスト（Claude Haiku 2024-03 価格）:
 *   input: $0.25 / 1M tokens、output: $1.25 / 1M tokens
 *   月 1,000 件 × 平均 500 input + 200 output tokens
 *   = 500,000 input + 200,000 output → $0.125 + $0.25 = $0.375
 *   ≒ ¥56（プロンプトキャッシュ込みでさらに減少）
 */
export const PRICE_INPUT_PER_M_TOKENS_USD = 0.25;
export const PRICE_OUTPUT_PER_M_TOKENS_USD = 1.25;

export function estimateCostUsd(input: number, output: number): number {
  return (
    (input / 1_000_000) * PRICE_INPUT_PER_M_TOKENS_USD +
    (output / 1_000_000) * PRICE_OUTPUT_PER_M_TOKENS_USD
  );
}

export interface PromptBundle {
  version: number;
  modelName: string;
  systemPrompt: string;
  jsonSchemaHint: string;
}

const SYSTEM_PROMPT_V1 = `あなたは運送業 STEELO の配車管理アシスタントです。
LINE グループに流れたテキストメッセージを受け取り、それが「配車案内」かどうかを判定し、
配車案内の場合は構造化された案件情報を JSON で返してください。

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
「配車案内」以外のもの（完了報告、雑談、画像共有等）は \`isDispatch: false\` を返してください。

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

# 出力フォーマット（厳密に守る）

\`\`\`json
{
  "isDispatch": true | false,
  "confidence": "high" | "medium" | "low",
  "records": [
    {
      "driverName": "田中太郎" | null,
      "workDate": "2026-05-21" | null,
      "taskNumber": 1 | null,
      "taskName": "築地チャーター" | null,
      "pickupLocation": "東京" | null,
      "deliveryLocation": "築地" | null,
      "startTime": "06:00" | null,
      "endTime": "08:00" | null,
      "managementNumber": "BD-12345" | null
    }
  ],
  "reasoning": "判定の根拠を 1-2 文で"
}
\`\`\`

- isDispatch=false のときは records は [] にする。
- 業務名と時刻のどちらかが取れていない案件は confidence="low" にする。
- 全ての案件が完全に取れていれば "high"。

JSON 以外の文字を出力しないでください（markdown フェンスやコメント、前置きも禁止）。`;

const JSON_SCHEMA_HINT_V1 = `{
  "type": "object",
  "required": ["isDispatch", "confidence", "records"],
  "properties": {
    "isDispatch": {"type": "boolean"},
    "confidence": {"enum": ["high", "medium", "low"]},
    "records": {"type": "array", "items": {"type": "object"}},
    "reasoning": {"type": "string"}
  }
}`;

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
 * 解析対象メッセージから user prompt を組み立てる。driverHint があれば
 * 文脈として埋める（system プロンプト側には PII を入れない）。
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
${messageText}

JSON 形式で出力してください（マークダウンや前置きなし）。`;
}
