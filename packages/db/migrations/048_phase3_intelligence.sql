-- 048_phase3_intelligence.sql
-- Phase 3: 異常検知強化 (F8) + Slack 通知 (F9) + 月次 PDF レポート (F10)
--
-- 追加テーブル:
--   anomaly_baselines       — 運賃中央値 + SD ベースライン (driver_id × task_name)
--   notification_settings   — Slack Webhook 等の通知設定 (id=1 固定単一行)
--   notification_deliveries — 通知送信ジョブ (idempotency + claim 機構)
--   report_jobs             — 月次 PDF レポート生成ジョブ

-- ============================================================
-- anomaly_baselines
-- ============================================================
-- Phase 3 F8-1: 運賃中央値ベースライン
-- - task_name=NULL は driver-fallback ベースライン
-- - partial unique index で task_name IS NULL / IS NOT NULL を別々に一意化
--   (SQLite の UNIQUE は NULL を別値として扱うため通常 UNIQUE では不十分)
-- - recompute は対象世代の全置換 (DELETE → INSERT を D1 batch 内で実行)
CREATE TABLE IF NOT EXISTS anomaly_baselines (
  id              TEXT PRIMARY KEY,
  driver_id       TEXT NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  task_name       TEXT,                          -- NULL = driver 全体フォールバック
  median_fare     REAL NOT NULL,
  sd_fare         REAL NOT NULL,
  sample_size     INTEGER NOT NULL,
  baseline_scope  TEXT NOT NULL,                 -- 'task' | 'driver_fallback'
  period_from     TEXT NOT NULL,                 -- "YYYY-MM"
  period_to       TEXT NOT NULL,
  computed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_anomaly_baselines_task
  ON anomaly_baselines (driver_id, task_name) WHERE task_name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_anomaly_baselines_driver_all
  ON anomaly_baselines (driver_id) WHERE task_name IS NULL;
CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_driver
  ON anomaly_baselines (driver_id, task_name);

-- ============================================================
-- notification_settings
-- ============================================================
-- Phase 3 F9: LINE Messaging API 通知設定 (単一行、id=1 固定)
-- - LINE_CHANNEL_ACCESS_TOKEN は wrangler secret で別管理 (既存 Phase 1 のものを流用)
-- - line_target_id は通知の送信先 (User ID `U***` または Group ID `C***` または Room ID `R***`)
-- - GET API は target_id をマスク表示、PUT のみで書き換え可、DELETE 非対応
-- - migration で INSERT OR IGNORE で 1 行確保
CREATE TABLE IF NOT EXISTS notification_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  line_target_id      TEXT,                        -- "U..." (user) | "C..." (group) | "R..." (room)
  line_target_kind    TEXT,                        -- 'user' | 'group' | 'room' (line_target_id の prefix 検証用)
  enabled_events      TEXT NOT NULL DEFAULT '[]',  -- JSON: ['reconciliation_completed', 'monthly_reminder', 'llm_parse_failed_streak']
  last_test_at        TEXT,
  last_error          TEXT,                        -- LINE API HTTP status + 短い error message (本体 token は含めない)
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
INSERT OR IGNORE INTO notification_settings (id) VALUES (1);

-- ============================================================
-- notification_deliveries
-- ============================================================
-- Phase 3 F9: 通知送信ジョブ (永続化キュー)
-- - idempotency_key UNIQUE で enqueue 重複防止
-- - status='processing' + claimed_at + claimed_by で送信時の二重送信防止
-- - event_payload_json は Slack Block Kit ではなくイベント生データ
-- - payload_schema_ver で旧 schema 互換性確保 (送信時に Block Kit を組立)
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                  TEXT PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  event_type          TEXT NOT NULL,                 -- reconciliation_completed | monthly_reminder | llm_parse_failed_streak
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | processing | sent | failed | skipped
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  claimed_at          TEXT,
  claimed_by          TEXT,                          -- dispatcher invocation の UUID
  payload_schema_ver  INTEGER NOT NULL DEFAULT 1,
  event_payload_json  TEXT NOT NULL,                 -- イベント生データ (Slack 非依存)
  last_error          TEXT,                          -- URL 本体を含めない
  requested_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  sent_at             TEXT,
  next_retry_at       TEXT                           -- NULL = 即時試行可能
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
  ON notification_deliveries (status, next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_processing
  ON notification_deliveries (status, claimed_at) WHERE status = 'processing';

-- ============================================================
-- report_jobs
-- ============================================================
-- Phase 3 F10: 月次 PDF レポート生成ジョブ
-- - active_report_key UNIQUE で同 period × type の重複起動排他 (Phase 2 reconciliation_jobs と同パターン)
-- - source_*_id でジョブ開始時のデータ snapshot を固定 (元データ更新で PDF が混ざらない)
-- - report_type ごとの必須 source は createJob の DB クエリ層で 422 fail
CREATE TABLE IF NOT EXISTS report_jobs (
  id                            TEXT PRIMARY KEY,
  period                        TEXT NOT NULL,
  report_type                   TEXT NOT NULL,           -- reconciliation | client_summary | payment_summary
  status                        TEXT NOT NULL DEFAULT 'queued',
  template_version              INTEGER NOT NULL,
  r2_key                        TEXT,
  byte_size                     INTEGER,
  page_count                    INTEGER,
  source_import_batch_id        TEXT REFERENCES import_batches (id) ON DELETE SET NULL,
  source_reconciliation_job_id  TEXT REFERENCES reconciliation_jobs (id) ON DELETE SET NULL,
  source_payment_job_id         TEXT REFERENCES payment_jobs (id) ON DELETE SET NULL,
  error_message                 TEXT,
  requested_by                  TEXT NOT NULL,
  requested_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  started_at                    TEXT,
  completed_at                  TEXT,
  active_report_key             TEXT GENERATED ALWAYS AS (
    CASE WHEN status IN ('queued', 'running') THEN period || ':' || report_type END
  ) VIRTUAL,
  UNIQUE (active_report_key)
);
CREATE INDEX IF NOT EXISTS idx_report_jobs_period_status
  ON report_jobs (period, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_jobs_active
  ON report_jobs (active_report_key) WHERE active_report_key IS NOT NULL;
