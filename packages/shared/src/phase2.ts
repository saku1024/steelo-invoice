// =============================================================================
// STEELO Phase 2 - 共有型定義
// LLM 解析 (F2) + 自動照合エンジン (F4) で使う camelCase 型。
// =============================================================================

import type { AuditAction as Phase1AuditAction } from './steelo';

// -----------------------------------------------------------------------------
// Phase 2 で追加される audit action
// -----------------------------------------------------------------------------
export type Phase2AuditAction =
  | 'llm_parse_request'
  | 'llm_parse_reparse'
  | 'reconciliation_run'
  | 'reconciliation_review'
  | 'dispatch_manual_match'
  | 'dispatch_status_confirm';

/** Phase 1 + Phase 2 のマージ型。@line-crm/shared を使う側は AuditAction を使う */
export type ExtendedAuditAction = Phase1AuditAction | Phase2AuditAction;

// -----------------------------------------------------------------------------
// LLM Parse Result
// -----------------------------------------------------------------------------
export type LLMParseStatus = 'success' | 'failed' | 'pending';

export interface LLMParseResult {
  id: string;
  lineMessageId: string;
  modelName: string;
  promptVersion: number;
  inputJson: string;
  outputJson: string | null;
  status: LLMParseStatus;
  errorMessage: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  costUsd: number | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

/** LLM が出力する 1 案件分の構造化レコード（dispatch_records に対応） */
export interface LLMDispatchRecord {
  driverName: string | null;
  workDate: string | null; // "YYYY-MM-DD"
  taskNumber: number | null;
  taskName: string | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  startTime: string | null;
  endTime: string | null;
  managementNumber: string | null;
}

/** LLM 解析 1 回分の結果 */
export interface LLMParseOutput {
  isDispatch: boolean;
  records: LLMDispatchRecord[];
  confidence: 'high' | 'medium' | 'low';
  reasoning?: string; // モデルの判断理由（任意）
}

// -----------------------------------------------------------------------------
// Reconciliation
// -----------------------------------------------------------------------------
export type MatchStatus = 'matched' | 'client_only' | 'dispatch_only';
export type MatchMethod = 'strong' | 'fuzzy' | 'time' | 'none' | 'manual';
export type ReconciliationLifeStatus = 'active' | 'archived' | 'archived_reviewed';

/**
 * Phase 3 (F8) 反映: warnings は string[] から StructuredWarning[] に拡張。
 * 既存 DB データ (Phase 2 の文字列配列) は parseWarnings() で読み出し時に
 * 互換変換される (Codex Phase 3 round 1 CRITICAL #2)。
 */
export interface Reconciliation {
  id: string;
  period: string;
  reconciliationJobId: string | null;
  dispatchId: string | null;
  clientRecordId: string | null;
  matchStatus: MatchStatus;
  matchMethod: MatchMethod;
  matchScore: number;
  // Phase 3 で型を変更。実体は phase3.ts の StructuredWarning。
  // 循環参照を避けるため `unknown` でも書けるが、ここでは利便性優先で import なしの
  // 構造リテラルを書く (TypeScript の declaration merging で phase3.ts と整合)
  warnings: Array<{
    type: string;
    severity: 'warn' | 'info';
    message: string;
    data: Record<string, unknown>;
  }>;
  status: ReconciliationLifeStatus;
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  notes: string | null;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// Reconciliation Job
// -----------------------------------------------------------------------------
export type ReconciliationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export interface ReconciliationJob {
  id: string;
  period: string;
  status: ReconciliationJobStatus;
  progress: number;
  dispatchCount: number;
  clientCount: number;
  matchedCount: number;
  clientOnlyCount: number;
  dispatchOnlyCount: number;
  errorMessage: string | null;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
