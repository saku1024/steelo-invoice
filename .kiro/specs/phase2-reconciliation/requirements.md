# Requirements Document — Phase 2 Reconciliation

## Introduction

STEELO Phase 1 では「LINE メッセージを蓄積し → 元請け Excel を取り込み →
手動で照合 → 支払明細を出力する」という半自動化を達成した。Phase 2 では、
**LINE メッセージから dispatch_records を自動構造化（F2）** し、
**dispatch_records と client_records を自動マッチング（F4）** することで、
本来のプロダクト価値である「**稼働照合（matched / client_only / dispatch_only）の
自動検出**」を完成させる。

ベースは Phase 1 と同じ Cloudflare Workers + Hono + D1 + Next.js 15 構成。
Claude Haiku API を Cloudflare Workers から呼び出して LLM 解析を行う。

## Boundary Context

- **In scope**:
  - F2: LINE 配車メッセージを Claude Haiku で構造化 → `dispatch_records` に保存
  - F4: 自動照合エンジン（dispatch × client_records を日付 / ドライバー / 業務名で
    マッチング、3 分類で `reconciliations` テーブルに保存）
  - F5 拡張: 照合結果一覧画面、差分ハイライト、手動マッチング UI
- **Out of scope**:
  - 配車レコードの手動入力（Phase 1 で実装済み、Phase 2 では補助手段として残す）
  - 支払明細生成ロジックの変更（Phase 1 の挙動を維持）
  - 異常検知の高度化（金額異常、時刻矛盾等は Phase 3）
- **Adjacent expectations**:
  - Phase 1 の `dispatch_records.status` カラムが `auto` / `needs_review` /
    `confirmed` の 3 値で運用されることを前提とする
  - `dispatch_records.confidence` を LLM 解析の信頼度として使う
    （Phase 1 では常に 'high' だったが、Phase 2 では 'high' / 'medium' / 'low'）
  - Cloudflare Access + Bearer 認証 + STEELO_WEB_ORIGINS CORS は Phase 1 と共通

## Requirements

### Requirement 1: LINE メッセージの LLM 解析（F2）

**Objective:** 管理者として、LINE 配車グループに流れた「配車案内」メッセージを
人手を介さずに dispatch_records として構造化したい。これにより毎日の手入力作業を
ゼロにする。

#### Acceptance Criteria

1. When `line_messages` に新規メッセージが INSERT された場合、the system shall
   Cloudflare Queues（または Scheduled fallback）にジョブを投入し、非同期で
   Claude Haiku API を呼び出して構造化解析する。
2. The system shall プロンプトに「配車メッセージか否か」「ドライバー名（複数可）」
   「日付」「案件番号」「業務名」「積込先」「納品先」「開始/終了時刻」
   「動態管理番号」を含む JSON Schema 出力を要求する。
3. When LLM が「配車メッセージではない」と判定した場合、the system shall
   `line_messages.is_dispatch = 0` に更新し、`dispatch_records` は作成しない。
4. When LLM 解析が成功し配車メッセージと判定された場合、the system shall
   1 メッセージあたり 1〜N 件（複数案件）の `dispatch_records` を作成し、
   - `status = 'auto'`（または信頼度低なら `'needs_review'`）
   - `confidence = 'high' | 'medium' | 'low'`（LLM 出力の confidence + 検証）
   - `raw_message_id` に `line_messages.id` を設定
   とする。
5. The system shall LLM 解析結果を `llm_parse_results` テーブルに保存し、
   `message_id` UNIQUE で同メッセージの二重解析を防ぐ。`prompt_version` と
   `model_name`（`claude-3-haiku-20240307` 等）をスナップショット保存する。
6. When LLM API がタイムアウト / 5xx / レート制限を返した場合、the system shall
   ジョブを exponential backoff（1s / 5s / 30s / 5min）でリトライし、4 回失敗時は
   `llm_parse_results.status = 'failed'` を記録、`line_messages.is_parsed = 1`
   は更新しない（次回スキャンで再試行可能にする）。
7. The system shall LLM 呼び出しに 1 回あたり 30 秒のタイムアウトを設定し、
   `services/llm-client.ts` 経由で `ANTHROPIC_API_KEY` を Cloudflare Workers
   secret から読む。
8. The system shall LLM 解析の入力（プロンプト + メッセージ本文）と出力（JSON）を
   `llm_parse_results.input_json` / `output_json` に保存し、監査と検証に使える状態にする。
9. While 月 1,000 件規模での想定コストを抑えるため、the system shall
   メッセージ本文が 10 文字未満、または `message_type !== 'text'` の場合は
   解析をスキップして `is_parsed = 1, is_dispatch = 0` に直接更新する。

### Requirement 2: 自動照合エンジン（F4）

**Objective:** 管理者として、`dispatch_records`（LINE 由来）と `client_records`
（元請け Excel 由来）を自動マッチングし、計上漏れ・金額相違の候補を 3 分類で
検出したい。

#### Acceptance Criteria

1. When 管理者が照合実行画面で対象月（YYYY-MM）を選択し「照合実行」を押した場合、
   the system shall その月の `dispatch_records` と当該 period の confirmed
   `import_batch` 配下 `client_records` を全件取得し、マッチング処理を実行する。
2. The system shall 1 件のマッチングを以下の優先順で判定する:
   - **strong match**: (1) 同日（`work_date == period + work_day`）かつ
     (2) `driver_id` 同一かつ (3) `task_name` 完全一致 → score=1.0
   - **fuzzy match**: 同日 + 同一 driver_id + task_name の正規化（空白除去 +
     カタカナ統一）後 Levenshtein 距離 ≤ 2 → score=0.7
   - **time/distance アシスト**: 同日 + 同一 driver_id で、業務名は異なるが
     時刻が ±30 分以内 → score=0.5（manual review 推奨）
   - **未マッチ**: 上記いずれも該当なし
3. The system shall マッチング結果を `reconciliations` テーブルに以下の 3 分類で
   保存する:
   - `matched`: dispatch + client_record の両方が紐付き、score ≥ 0.5
   - `client_only`: client_record はあるが dispatch なし
   - `dispatch_only`: dispatch はあるが client_record なし
4. The system shall 同一 period で複数回照合実行された場合、既存
   `reconciliations` を `status = 'archived'` にしてから新しい結果を作成する
   （`reviewed = 1` のものは状態を `archived_reviewed` で残し、再 review を促す）。
5. The system shall 各マッチング行に `match_score`（0-1 の REAL）と
   `match_method`（`'strong' | 'fuzzy' | 'time' | 'none'`）を保存する。
6. While 月 1,000 件規模で性能を保つため、the system shall 月次照合を 60 秒以内に
   完了する（非同期ジョブとして実行、UI はポーリング）。
7. The system shall 照合結果に `warnings` JSON 列を持ち、
   - 金額異常（`client_record.fare` が同 driver の他レコードから 50% 以上乖離）
   - 立替金矛盾（dispatch にメモがあるのに client_record.advance_payment=0）
   等の検出ルールを 1 件ずつ JSON 配列で記録する。

### Requirement 3: 照合結果画面と差分レビュー（F5 拡張）

**Objective:** 管理者として、照合結果を 3 分類で一覧し、不一致や疑わしい行を
レビュー・手動マッチングしたい。

#### Acceptance Criteria

1. The system shall `/reconciliations` 画面で対象月を選択し、
   `matched` / `client_only` / `dispatch_only` の 3 タブを提供する。
2. The system shall 各タブで、件数バッジ、フィルタ（ドライバー / 業務名 / status）、
   並び替え（日付昇順/降順、score昇順）、ページングを提供する。
3. When 管理者が `matched` 行を開いた場合、the system shall dispatch と
   client_record を左右並列で表示し、差分のあるフィールド（業務名 / 時刻 / 金額）を
   ハイライト表示する。
4. When 管理者が「確認済み」ボタンを押した場合、the system shall
   `reconciliations.reviewed = 1, reviewed_at = now, reviewed_by = staff_id` を保存する。
5. When 管理者が `dispatch_only` の行に対して「手動マッチ」を実行した場合、
   the system shall 同月の未マッチ `client_records` を候補として表示し、
   選択された行と `match_method = 'manual'` でマッチング作成する。
6. When 管理者が `client_only` の行を「ダミー dispatch 追加」した場合、
   the system shall その client_record と紐付く `dispatch_records` を
   `status='confirmed'`、`raw_message_id=NULL`、`confidence='manual'` で作成する。
7. The system shall 照合実行ボタンに「直近の実行状況」（実行中 / 完了 / 失敗）と
   進捗率を表示し、二重実行をジョブ UNIQUE 制約で防ぐ。

### Requirement 4: dispatch_records UI 拡張

**Objective:** Phase 1 の手動入力に加え、Phase 2 で auto / needs_review 状態の
レコードを管理者がレビュー・修正できるようにする。

#### Acceptance Criteria

1. The system shall `/dispatch-records` 一覧に `status` バッジ（auto / needs_review /
   confirmed）と `confidence` バッジを表示する。
2. The system shall フィルタに `status` と `confidence` を追加する。
3. When 管理者が `needs_review` 行を編集して保存した場合、the system shall
   `status = 'confirmed'`、`confidence = 'high'` に上書きする。
4. When 管理者が `auto` 行を確認済みにマークした場合、the system shall
   内容を変更せず `status = 'confirmed'` のみ更新する（`confidence` は維持）。
5. The system shall 元メッセージ（`raw_message_id`）を辿って LINE 本文と
   LLM 出力 JSON を別パネルで表示する。

### Requirement 5: LLM 解析の品質保証

**Objective:** 開発者として、LLM 解析が業務要件を満たす精度・コストを維持しているか
継続的に検証したい。

#### Acceptance Criteria

1. The system shall 過去の LINE メッセージから 30 件のゴールデンセット（人手で
   正解を作成）を `tests/fixtures/llm-golden.json` に保持し、CI / cron で
   解析精度を計測する。
2. While LLM 解析精度の SLO として、the system shall ゴールデンセットに対し
   「is_dispatch 判定の F1 ≥ 0.9」「dispatch_records フィールド一致率 ≥ 0.85」を
   満たすことをベンチで確認する。
3. The system shall プロンプトを `services/llm-prompts.ts` で `version` 番号付きで
   管理し、変更時は `prompt_version` を bump する。`llm_parse_results.prompt_version`
   と紐付けて回帰検証可能にする。
4. The system shall Claude Haiku API 呼び出しコストを `llm_parse_results.token_usage`
   （input / output / cost_usd）で記録し、月次集計を `/api/llm-stats` で参照可能にする。

### Requirement 6: 非機能要件

**Objective:** Phase 2 機能が Phase 1 の運用品質を維持しつつ追加されることを保証する。

#### Acceptance Criteria

1. The system shall LLM 解析を非同期ジョブで実行し、Webhook 応答時間（200 を 3 秒以内）を維持する。
2. The system shall 月次照合（1,000 件規模）を 60 秒以内に完了し、進捗を
   `reconciliation_jobs.progress` で 0-100 として返す。
3. The system shall Phase 1 の既存テストを全件保持する。Phase 2 追加機能の
   テストは worker / db それぞれで unit + integration を備える。
4. The system shall LLM API 呼び出しに `prompt_caching` を有効化し、共通プロンプトの
   token コストを抑える。
5. The system shall `audit_logs` に新規アクション（`llm_parse_request` /
   `reconciliation_run` / `reconciliation_review` / `dispatch_manual_match`）を追加する。

### Requirement 7: データモデル拡張

**Objective:** Phase 2 で必要となる新規テーブルとカラム拡張を整理する。

#### Acceptance Criteria

1. The system shall migration `047_phase2_reconciliation.sql` で以下を追加する:
   - `llm_parse_results` テーブル（message_id UNIQUE、prompt_version、model_name、
     input/output JSON、token_usage、status、error_message、created_at）
   - `reconciliations` テーブル（dispatch_id FK NULL 可、client_record_id FK NULL 可、
     period、match_status、match_method、match_score、warnings JSON、reviewed、
     reviewed_at、reviewed_by、created_at）
   - `reconciliation_jobs` テーブル（id PK、period、status、progress、
     dispatch_count、client_count、matched_count、reviewed_by、active_period_key
     generated UNIQUE）
2. The system shall `audit_logs.action` に新規アクションを追加する型を
   `@line-crm/shared` に反映する。
3. The system shall Phase 1 の `dispatch_records` テーブルにカラム追加なし
   （`status` / `confidence` は既存のまま運用）。
