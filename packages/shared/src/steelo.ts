// =============================================================================
// STEELO Phase 1 MVP - 共有型定義
// D1 から取得した snake_case 行は Worker の routes 層で camelCase に変換する。
// 全金額は INTEGER（円単位）。boolean は D1 上 INTEGER(0/1) で格納される。
// =============================================================================

// -----------------------------------------------------------------------------
// Driver (ドライバーマスタ)
// -----------------------------------------------------------------------------
export interface Driver {
  id: string;
  name: string;
  nameKana: string | null;
  lineGroupId: string | null;
  lineGroupName: string | null;
  hasInvoice: boolean;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriverCreate {
  name: string;
  nameKana?: string | null;
  lineGroupId?: string | null;
  lineGroupName?: string | null;
  hasInvoice?: boolean;
  isActive?: boolean;
  notes?: string | null;
}

export type DriverUpdate = Partial<DriverCreate>;

// -----------------------------------------------------------------------------
// DriverAlias (Excel DR 名のゆれ吸収)
// -----------------------------------------------------------------------------
export interface DriverAlias {
  id: string;
  driverId: string;
  aliasName: string;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// DriverDeduction (per-driver per-period 控除マスタ)
// -----------------------------------------------------------------------------
export interface DriverDeduction {
  id: string;
  driverId: string;
  period: string; // "YYYY-MM"
  vehicleCost: number;
  processingFee: number;
  prepayment: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface DriverDeductionUpsert {
  driverId: string;
  period: string;
  vehicleCost: number;
  processingFee: number;
  prepayment: number;
  notes?: string | null;
}

// -----------------------------------------------------------------------------
// LineMessage (LINE グループメッセージの生データ)
// -----------------------------------------------------------------------------
export type LineMessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'video'
  | 'audio'
  | 'sticker';

export interface LineMessage {
  id: string;
  groupId: string;
  driverId: string | null;
  senderUserId: string | null;
  senderName: string | null;
  messageId: string;
  messageType: LineMessageType;
  messageText: string | null;
  isDispatch: boolean;
  isParsed: boolean;
  receivedAt: string;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// DispatchRecord (配車レコード、Phase 1 は手動入力)
// -----------------------------------------------------------------------------
export interface DispatchRecord {
  id: string;
  driverId: string;
  workDate: string; // "YYYY-MM-DD"
  taskNumber: number | null;
  taskName: string | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  startTime: string | null;
  endTime: string | null;
  managementNumber: string | null;
  rawMessageId: string | null;
  confidence: 'high' | 'medium' | 'low';
  status: 'auto' | 'needs_review' | 'confirmed';
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// ImportPreview (Excel プレビュー索引、本体は R2)
// -----------------------------------------------------------------------------
export interface ImportPreview {
  previewId: string;
  period: string;
  fileName: string | null;
  rowCount: number;
  summaryJson: string;
  r2Key: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

// -----------------------------------------------------------------------------
// ImportBatch (BOND's Excel インポート履歴)
// header_* は会社合計の参照値であり、支払計算には使わない。
// -----------------------------------------------------------------------------
export type ImportBatchStatus = 'pending' | 'confirmed' | 'archived';

export interface ImportBatch {
  id: string;
  period: string;
  fileName: string | null;
  totalRecords: number;
  totalFare: number;
  totalAdvance: number;
  headerVehicleCost: number;
  headerProcessingFee: number;
  headerPrepayment: number;
  commissionRate: number;
  taxRate: number;
  templateVersion: string | null;
  status: ImportBatchStatus;
  importedAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

// -----------------------------------------------------------------------------
// ClientRecord (元請け Excel 明細行)
// -----------------------------------------------------------------------------
export interface ClientRecord {
  id: string;
  importBatchId: string;
  driverId: string | null;
  period: string;
  workDay: number;
  dayOfWeek: string | null;
  taskName: string | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  startTime: string | null;
  endTime: string | null;
  distanceKm: number | null;
  advancePayment: number;
  /** 税抜運賃。NULL = 同便従属行 */
  fare: number | null;
  /** Excel 上の DR 名（生値） */
  driverName: string | null;
  notes: string | null;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// DriverPaymentSummary (生成時スナップショット)
// -----------------------------------------------------------------------------
export interface DriverPaymentSummary {
  id: string;
  driverId: string;
  period: string;
  importBatchId: string;
  paymentJobId: string | null;
  driverNameSnapshot: string;
  hasInvoiceSnapshot: boolean;
  commissionRateSnapshot: number;
  taxRateSnapshot: number;
  roundingRule: 'per_line_round';
  totalFareBeforeTax: number;
  totalFareWithTax: number;
  totalAdvance: number;
  vehicleCost: number;
  processingFee: number;
  prepayment: number;
  finalAmount: number;
  r2XlsxKey: string | null;
  generatedAt: string;
}

// -----------------------------------------------------------------------------
// PaymentSummaryLine (明細行スナップショット)
// -----------------------------------------------------------------------------
export interface PaymentSummaryLine {
  id: string;
  summaryId: string;
  clientRecordId: string | null;
  workDay: number;
  taskName: string | null;
  fare: number | null;
  fareAfterCommission: number | null;
  fareWithTax: number | null;
  advancePayment: number;
  excludedFromCalc: boolean;
}

// -----------------------------------------------------------------------------
// PaymentJob (一括ZIP 非同期ジョブ)
// -----------------------------------------------------------------------------
export type PaymentJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface PaymentJob {
  id: string;
  period: string;
  status: PaymentJobStatus;
  progress: number;
  totalDrivers: number;
  doneDrivers: number;
  r2ZipKey: string | null;
  errorMessage: string | null;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// -----------------------------------------------------------------------------
// AuditLog (重要操作の監査証跡)
// -----------------------------------------------------------------------------
export type AuditAction =
  | 'webhook_save_failed'
  | 'driver_create'
  | 'driver_update'
  | 'driver_archive'
  | 'driver_alias_create'
  | 'driver_alias_delete'
  | 'deduction_update'
  | 'dispatch_create'
  | 'dispatch_update'
  | 'import_confirm'
  | 'import_overwrite'
  | 'import_archive'
  | 'payment_generate'
  | 'payment_job_request'
  | 'payment_batch_generate'
  // Phase 2 reconciliation
  | 'llm_parse_request'
  | 'llm_parse_reparse'
  | 'reconciliation_run'
  | 'reconciliation_review'
  | 'dispatch_manual_match'
  | 'dispatch_status_confirm'
  // Phase 3 intelligence
  | 'anomaly_baseline_recompute'
  | 'slack_notification_sent'
  | 'slack_notification_failed'
  | 'slack_notification_skipped'
  | 'report_generated'
  | 'notification_settings_updated';

export interface AuditLog {
  id: string;
  actorId: string;
  actorName: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  payloadJson: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// PaymentCalculator (純粋関数の入出力)
// -----------------------------------------------------------------------------
export interface PaymentInput {
  driver: { hasInvoice: boolean };
  /** 生成時スナップショット値 */
  rates: { commissionRate: number; taxRate: number };
  /** per-driver per-period の控除。batch ヘッダーは渡さない。 */
  deductions: {
    vehicleCost: number;
    processingFee: number;
    prepayment: number;
  };
  records: { fare: number | null; advancePayment: number }[];
}

export interface PaymentFareLine {
  fareAfterCommission: number | null;
  fareWithTax: number | null;
  advance: number;
  excludedFromCalc: boolean;
}

export interface PaymentResult {
  fareLines: PaymentFareLine[];
  totalFareBeforeTax: number;
  totalFareWithTax: number;
  totalAdvance: number;
  vehicleCost: number;
  processingFee: number;
  prepayment: number;
  finalAmount: number;
}
