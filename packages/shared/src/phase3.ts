// =============================================================================
// STEELO Phase 3 共有型定義
// 異常検知強化 (F8) + Slack 通知 (F9) + 月次 PDF レポート (F10) で使う camelCase 型
// =============================================================================

// -----------------------------------------------------------------------------
// F8: 異常検知強化
// -----------------------------------------------------------------------------

/**
 * 構造化された warning 1 件。Phase 2 では文字列配列だったが、Phase 3 で
 * type / severity / data を持つ object 配列に拡張する。
 * 既存 reconciliations.warnings (TEXT JSON) は parseWarnings() で読み出し時に
 * 後方互換を吸収する。
 */
export type WarningType =
  | 'fare_deviation_high'
  | 'time_inversion'
  | 'advance_payment_without_dispatch' // Phase 2 から維持
  | 'advance_payment_without_label'    // Phase 3 新規
  | 'dispatch_overload'
  | 'legacy_warning';                  // Phase 2 文字列の互換

export type WarningSeverity = 'warn' | 'info';

export interface StructuredWarning {
  type: WarningType;
  severity: WarningSeverity;
  message: string;
  data: Record<string, unknown>;
}

/** 異常検知ベースライン (driver_id × task_name 単位、3 ヶ月分から計算) */
export type BaselineScope = 'task' | 'driver_fallback';

export interface AnomalyBaseline {
  id: string;
  driverId: string;
  /** null = driver 全体フォールバック */
  taskName: string | null;
  medianFare: number;
  sdFare: number;
  sampleSize: number;
  baselineScope: BaselineScope;
  periodFrom: string; // "YYYY-MM"
  periodTo: string;
  computedAt: string;
}

// -----------------------------------------------------------------------------
// F9: Slack 通知
// -----------------------------------------------------------------------------

export type NotificationEvent =
  | 'reconciliation_completed'
  | 'monthly_reminder'
  | 'llm_parse_failed_streak';

export type DeliveryStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'skipped';

/** LINE 通知の送信先タイプ */
export type LineTargetKind = 'user' | 'group' | 'room';

/** 通知設定 (id=1 単一行)。LINE Messaging API push_message で送信 */
export interface NotificationSettings {
  id: 1;
  /** LINE 送信先 ID: User (U...) / Group (C...) / Room (R...)。null で無効化 */
  lineTargetId: string | null;
  /** マスク済み表示 (例: "U1234...abcd") */
  lineTargetIdMasked: string | null;
  /** lineTargetId の種別。prefix 検証用 */
  lineTargetKind: LineTargetKind | null;
  /** 有効化されているイベント。空配列なら通知無効 */
  enabledEvents: NotificationEvent[];
  lastTestAt: string | null;
  /** LINE API HTTP status + 短い error message (本体 token は含めない) */
  lastError: string | null;
  updatedAt: string;
}

/** 通知送信ジョブ (永続化キュー) */
export interface NotificationDelivery {
  id: string;
  /** 重複防止用キー (例: `reconciliation_completed:{jobId}`) */
  idempotencyKey: string;
  eventType: NotificationEvent;
  status: DeliveryStatus;
  attemptCount: number;
  /** dispatcher が claim したタイムスタンプ */
  claimedAt: string | null;
  /** dispatcher invocation の UUID */
  claimedBy: string | null;
  /** payload schema バージョン (送信時 Block Kit 組立に使う) */
  payloadSchemaVer: number;
  /** イベント生データ (Slack 非依存) */
  eventPayloadJson: string;
  /** URL 本体は含めない */
  lastError: string | null;
  requestedAt: string;
  sentAt: string | null;
  /** null = 即時試行可能、それ以外は <= now で試行可能 */
  nextRetryAt: string | null;
}

// -----------------------------------------------------------------------------
// F10: 月次 PDF レポート
// -----------------------------------------------------------------------------

export type ReportType =
  | 'reconciliation'    // P0: 照合結果レポート
  | 'client_summary'    // P1: 元請けサマリー
  | 'payment_summary';  // P2: 支払明細サマリー (Phase 3 では実装着手前に再評価)

export type ReportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ReportJob {
  id: string;
  period: string;
  reportType: ReportType;
  status: ReportJobStatus;
  templateVersion: number;
  r2Key: string | null;
  byteSize: number | null;
  pageCount: number | null;
  /** report_type ごとの必須 source ID (createJob 時に解決) */
  sourceImportBatchId: string | null;
  sourceReconciliationJobId: string | null;
  sourcePaymentJobId: string | null;
  errorMessage: string | null;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// -----------------------------------------------------------------------------
// Phase 3 で追加される audit action
// -----------------------------------------------------------------------------
export type Phase3AuditAction =
  | 'anomaly_baseline_recompute'
  | 'notification_sent'
  | 'notification_failed'
  | 'notification_skipped'
  | 'report_generated'
  | 'notification_settings_updated';
