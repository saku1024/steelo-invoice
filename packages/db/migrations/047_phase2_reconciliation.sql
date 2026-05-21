-- 047_phase2_reconciliation.sql
-- Phase 2: LLM (Claude Haiku) 配車メッセージ解析 + 自動照合エンジン
--
-- 追加テーブル:
--   llm_parse_results    — LINE メッセージの LLM 解析結果（監査・回帰検証用）
--   reconciliations      — dispatch_records × client_records の 3 分類照合結果
--   reconciliation_jobs  — 月次照合の非同期ジョブ管理

-- ============================================================
-- llm_parse_results
-- ============================================================
-- 1 line_message に対して 1 件（UNIQUE）。リトライ時は UPDATE。
CREATE TABLE IF NOT EXISTS llm_parse_results (
  id              TEXT PRIMARY KEY,
  line_message_id TEXT NOT NULL REFERENCES line_messages (id) ON DELETE CASCADE,
  model_name      TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL,
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  status          TEXT NOT NULL,
  error_message   TEXT,
  token_input     INTEGER,
  token_output    INTEGER,
  cost_usd        REAL,
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (line_message_id)
);
CREATE INDEX IF NOT EXISTS idx_llm_parse_status_time
  ON llm_parse_results (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_parse_message
  ON llm_parse_results (line_message_id);

-- ============================================================
-- reconciliation_jobs
-- ============================================================
-- 同一 period で active なジョブを 1 つに制限する。
CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  id                  TEXT PRIMARY KEY,
  period              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  progress            INTEGER NOT NULL DEFAULT 0,
  dispatch_count      INTEGER NOT NULL DEFAULT 0,
  client_count        INTEGER NOT NULL DEFAULT 0,
  matched_count       INTEGER NOT NULL DEFAULT 0,
  client_only_count   INTEGER NOT NULL DEFAULT 0,
  dispatch_only_count INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  requested_by        TEXT NOT NULL,
  requested_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  started_at          TEXT,
  completed_at        TEXT,
  active_period_key   TEXT GENERATED ALWAYS AS (
    CASE WHEN status IN ('queued', 'running') THEN period END
  ) VIRTUAL,
  UNIQUE (active_period_key)
);
CREATE INDEX IF NOT EXISTS idx_recon_jobs_period_status
  ON reconciliation_jobs (period, status);

-- ============================================================
-- reconciliations
-- ============================================================
-- 1 期間 × 1 ジョブで N 件の照合行。旧ジョブの結果は status='archived' に。
CREATE TABLE IF NOT EXISTS reconciliations (
  id                    TEXT PRIMARY KEY,
  period                TEXT NOT NULL,
  reconciliation_job_id TEXT REFERENCES reconciliation_jobs (id) ON DELETE SET NULL,
  dispatch_id           TEXT REFERENCES dispatch_records (id) ON DELETE SET NULL,
  client_record_id      TEXT REFERENCES client_records (id) ON DELETE SET NULL,
  match_status          TEXT NOT NULL,
  match_method          TEXT NOT NULL,
  match_score           REAL NOT NULL DEFAULT 0,
  warnings              TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  reviewed              INTEGER NOT NULL DEFAULT 0,
  reviewed_at           TEXT,
  reviewed_by           TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_recons_period_status
  ON reconciliations (period, status, match_status);
CREATE INDEX IF NOT EXISTS idx_recons_dispatch
  ON reconciliations (dispatch_id);
CREATE INDEX IF NOT EXISTS idx_recons_client
  ON reconciliations (client_record_id);
CREATE INDEX IF NOT EXISTS idx_recons_job
  ON reconciliations (reconciliation_job_id);
