-- 046_steelo_phase1.sql
-- STEELO 稼働照合・ドライバー支払明細システム Phase 1 MVP のテーブル群を追加。
-- Codex (gpt-5.5) レビュー反映済み（design.md 参照）。
--
-- 含まれるテーブル:
--   drivers / driver_aliases / line_messages / dispatch_records
--   import_previews / import_batches / client_records / driver_deductions
--   driver_payment_summaries / payment_summary_lines / payment_jobs / audit_logs
--
-- 重要な不変条件:
--   - line_messages.message_id UNIQUE で LINE Webhook 再送の冪等性を担保
--   - driver_aliases.alias_name UNIQUE（Excel DR 名のゆれ吸収）
--   - import_batches: generated column period_confirmed_key + UNIQUE で
--     同一 period の confirmed 重複を DB 側で排他（archived/pending は複数許可）
--   - payment_jobs: generated column active_period_key + UNIQUE で
--     同一 period の queued/running ジョブ重複を DB 側で排他
--   - driver_deductions UNIQUE(driver_id, period): per-driver per-period
--   - driver_payment_summaries UNIQUE(driver_id, period) でスナップショット UPSERT

-- ============================================================
-- drivers (ドライバーマスタ)
-- ============================================================
CREATE TABLE IF NOT EXISTS drivers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  name_kana        TEXT,
  line_group_id    TEXT UNIQUE,
  line_group_name  TEXT,
  has_invoice      INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_drivers_line_group_id ON drivers (line_group_id);
CREATE INDEX IF NOT EXISTS idx_drivers_is_active ON drivers (is_active);

-- ============================================================
-- driver_aliases (Excel DR 名のゆれ吸収)
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_aliases (
  id          TEXT PRIMARY KEY,
  driver_id   TEXT NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  alias_name  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (alias_name)
);
CREATE INDEX IF NOT EXISTS idx_driver_aliases_driver ON driver_aliases (driver_id);

-- ============================================================
-- line_messages (LINE グループメッセージの生データ)
-- ============================================================
CREATE TABLE IF NOT EXISTS line_messages (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  driver_id       TEXT REFERENCES drivers (id) ON DELETE SET NULL,
  sender_user_id  TEXT,
  sender_name     TEXT,
  message_id      TEXT NOT NULL,
  message_type    TEXT NOT NULL,
  message_text    TEXT,
  is_dispatch     INTEGER NOT NULL DEFAULT 0,
  is_parsed       INTEGER NOT NULL DEFAULT 0,
  received_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS idx_line_messages_driver_received ON line_messages (driver_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_messages_group_received ON line_messages (group_id, received_at DESC);

-- ============================================================
-- dispatch_records (配車レコード、Phase 1 は手動入力)
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch_records (
  id                  TEXT PRIMARY KEY,
  driver_id           TEXT NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  work_date           TEXT NOT NULL,
  task_number         INTEGER,
  task_name           TEXT,
  pickup_location     TEXT,
  delivery_location   TEXT,
  start_time          TEXT,
  end_time            TEXT,
  management_number   TEXT,
  raw_message_id      TEXT REFERENCES line_messages (id) ON DELETE SET NULL,
  confidence          TEXT NOT NULL DEFAULT 'high',
  status              TEXT NOT NULL DEFAULT 'confirmed',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_driver_date ON dispatch_records (driver_id, work_date);

-- ============================================================
-- import_previews (Excel プレビュー索引、本体は R2)
-- ============================================================
CREATE TABLE IF NOT EXISTS import_previews (
  preview_id   TEXT PRIMARY KEY,
  period       TEXT NOT NULL,
  file_name    TEXT,
  row_count    INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_previews_expires ON import_previews (expires_at);

-- ============================================================
-- import_batches (BOND's Excel インポート履歴)
-- header_* は会社合計の参照値。各ドライバーの控除には使わない。
-- ============================================================
CREATE TABLE IF NOT EXISTS import_batches (
  id                     TEXT PRIMARY KEY,
  period                 TEXT NOT NULL,
  file_name              TEXT,
  total_records          INTEGER NOT NULL DEFAULT 0,
  total_fare             INTEGER NOT NULL DEFAULT 0,
  total_advance          INTEGER NOT NULL DEFAULT 0,
  header_vehicle_cost    INTEGER NOT NULL DEFAULT 0,
  header_processing_fee  INTEGER NOT NULL DEFAULT 0,
  header_prepayment      INTEGER NOT NULL DEFAULT 0,
  commission_rate        REAL NOT NULL DEFAULT 0.075,
  tax_rate               REAL NOT NULL DEFAULT 0.10,
  template_version       TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  period_confirmed_key   TEXT GENERATED ALWAYS AS (CASE WHEN status='confirmed' THEN period END) VIRTUAL,
  imported_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  confirmed_at           TEXT,
  confirmed_by           TEXT,
  UNIQUE (period_confirmed_key)
);
CREATE INDEX IF NOT EXISTS idx_import_batches_period_status ON import_batches (period, status);

-- ============================================================
-- client_records (元請け Excel 明細行)
-- ============================================================
CREATE TABLE IF NOT EXISTS client_records (
  id                TEXT PRIMARY KEY,
  import_batch_id   TEXT NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  driver_id         TEXT REFERENCES drivers (id) ON DELETE SET NULL,
  period            TEXT NOT NULL,
  work_day          INTEGER NOT NULL,
  day_of_week       TEXT,
  task_name         TEXT,
  pickup_location   TEXT,
  delivery_location TEXT,
  start_time        TEXT,
  end_time          TEXT,
  distance_km       REAL,
  advance_payment   INTEGER NOT NULL DEFAULT 0,
  fare              INTEGER,
  driver_name       TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_client_records_batch ON client_records (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_client_records_driver_period ON client_records (driver_id, period);

-- ============================================================
-- driver_deductions (per-driver per-period 控除マスタ)
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_deductions (
  id              TEXT PRIMARY KEY,
  driver_id       TEXT NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  period          TEXT NOT NULL,
  vehicle_cost    INTEGER NOT NULL DEFAULT 0,
  processing_fee  INTEGER NOT NULL DEFAULT 0,
  prepayment      INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_by      TEXT,
  UNIQUE (driver_id, period)
);
CREATE INDEX IF NOT EXISTS idx_driver_deductions_period ON driver_deductions (period);

-- ============================================================
-- payment_jobs (非同期一括ジョブ)
-- driver_payment_summaries が参照するため先に定義
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_jobs (
  id                TEXT PRIMARY KEY,
  period            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  progress          INTEGER NOT NULL DEFAULT 0,
  total_drivers     INTEGER NOT NULL DEFAULT 0,
  done_drivers      INTEGER NOT NULL DEFAULT 0,
  r2_zip_key        TEXT,
  error_message     TEXT,
  requested_by      TEXT NOT NULL,
  requested_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  started_at        TEXT,
  completed_at      TEXT,
  active_period_key TEXT GENERATED ALWAYS AS (
    CASE WHEN status IN ('queued','running') THEN period END
  ) VIRTUAL,
  UNIQUE (active_period_key)
);
CREATE INDEX IF NOT EXISTS idx_payment_jobs_period_status ON payment_jobs (period, status);

-- ============================================================
-- driver_payment_summaries (生成時スナップショット)
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_payment_summaries (
  id                       TEXT PRIMARY KEY,
  driver_id                TEXT NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  period                   TEXT NOT NULL,
  import_batch_id          TEXT NOT NULL REFERENCES import_batches (id),
  payment_job_id           TEXT REFERENCES payment_jobs (id) ON DELETE SET NULL,
  driver_name_snapshot     TEXT NOT NULL,
  has_invoice_snapshot     INTEGER NOT NULL,
  commission_rate_snapshot REAL NOT NULL,
  tax_rate_snapshot        REAL NOT NULL,
  rounding_rule            TEXT NOT NULL DEFAULT 'per_line_round',
  total_fare_before_tax    INTEGER NOT NULL,
  total_fare_with_tax      INTEGER NOT NULL,
  total_advance            INTEGER NOT NULL,
  vehicle_cost             INTEGER NOT NULL DEFAULT 0,
  processing_fee           INTEGER NOT NULL DEFAULT 0,
  prepayment               INTEGER NOT NULL DEFAULT 0,
  final_amount             INTEGER NOT NULL,
  r2_xlsx_key              TEXT,
  generated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (driver_id, period)
);
CREATE INDEX IF NOT EXISTS idx_payment_summaries_period ON driver_payment_summaries (period);
CREATE INDEX IF NOT EXISTS idx_payment_summaries_batch ON driver_payment_summaries (import_batch_id);

-- ============================================================
-- payment_summary_lines (明細行スナップショット)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_summary_lines (
  id                    TEXT PRIMARY KEY,
  summary_id            TEXT NOT NULL REFERENCES driver_payment_summaries (id) ON DELETE CASCADE,
  client_record_id      TEXT REFERENCES client_records (id) ON DELETE SET NULL,
  work_day              INTEGER NOT NULL,
  task_name             TEXT,
  fare                  INTEGER,
  fare_after_commission INTEGER,
  fare_with_tax         INTEGER,
  advance_payment       INTEGER NOT NULL DEFAULT 0,
  excluded_from_calc    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payment_summary_lines_summary ON payment_summary_lines (summary_id);

-- ============================================================
-- audit_logs (重要操作の監査証跡)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL,
  actor_name      TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  payload_json    TEXT,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_time ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs (action, created_at DESC);
