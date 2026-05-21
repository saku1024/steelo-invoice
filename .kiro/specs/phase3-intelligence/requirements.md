# Requirements Document — Phase 3 Intelligence

## Introduction

STEELO Phase 2 までで、LINE → LLM 自動解析 → 元請け Excel との自動照合 → 支払明細
生成のフル自動化に到達した。月初の運用は劇的に短縮されたが、**「異常があった時に
気づくのは管理者が画面を開いた時」「元請けへの月次レポート作成は依然手作業」**
という残り課題がある。

Phase 3 では Phase 2 までの基盤を活かしつつ、以下 3 つの業務支援を追加する:

- **F8 異常検知強化**: 運賃中央値の自動学習、時刻矛盾、立替金整合性で warning の
  ノイズを下げて精度を上げる
- **F9 Slack 通知**: 照合完了 / 異常検出 / 月初リマインドをチャンネルに自動投稿し、
  管理者が画面を開く前に気づける状態にする
- **F10 月次レポート PDF**: 照合結果 + 支払明細サマリーを 1 枚の PDF にまとめ、
  元請け / 自社経理 / ドライバー向けに自動生成する

ベースは Phase 2 と同じ Cloudflare Workers + Hono + D1 + Next.js 15 構成。
PDF 生成は `pdf-lib` (Workers 互換) を使用。Slack は Incoming Webhook URL。

## Boundary Context

- **In scope**:
  - F8: `reconciliation.ts` の warnings 生成ロジック拡張 + `anomaly_baselines` 新規テーブル
  - F9: Slack webhook 送信サービス + `notification_settings` テーブル
  - F10: PDF 生成サービス + 月次レポートテンプレート + `/api/reports/*` ルート
  - 上記 3 機能の Web UI (`/settings/notifications`, `/reports`)
- **Out of scope**:
  - 異常検知のための LLM 利用（ルールベースで十分）
  - Slack 以外の通知チャネル（Email / LINE Notify など）
  - PDF カスタムテンプレート編集 UI（テンプレートはコード固定）
  - レポート PDF への手書きサイン / 押印フロー
- **Adjacent expectations**:
  - Phase 2 の `reconciliations.warnings` JSON 列を Phase 3 では構造化（`{type, severity, message, data}` の配列）に拡張する
  - `notification_settings` は単一管理者前提（multi-tenant 非対応）
  - PDF レポート出力先は既存 R2 `STEELO_FILES` bucket を流用

## Requirements

### Requirement 1: 運賃中央値の自動学習による異常検知 (F8-1)

**Objective:** 管理者として、Phase 2 の固定 50% 乖離しきい値ではなく、**過去 3 ヶ月の
ドライバー別 × 業務名別の中央値** をベースに運賃の異常を検出したい。これにより
false positive を減らし、本当に確認すべき行だけが highlight される状態にする。

#### Acceptance Criteria

1. The system shall 月初の照合実行前に、過去 3 ヶ月の `client_records` (confirmed
   batch のみ) から **driver_id × task_name 単位の運賃中央値・標準偏差** を
   `anomaly_baselines` テーブルに事前計算して保存する。
   - **Codex round 2 HIGH #4 反映**: 「過去 3 ヶ月」の定義を以下に固定:
     - `period=YYYY-MM` を照合対象月 (= recompute API のクエリパラメータ) とする
     - baseline 計算 source は `period` の **直前 3 完了月**:
       `period_from = period - 3 months`, `period_to = period - 1 month`
     - 例: `period=2026-05` → source は `2026-02 / 03 / 04` の 3 ヶ月分
   - **recompute は対象世代の全置換**:
     1. 対象 `period_from / period_to` 範囲の旧 baseline 行を DELETE
     2. 新 baseline 行を INSERT
     3. 両操作を D1 batch (1 トランザクション) 内で実行
     - 「以前は driver/task 組合せがあったが今は無い」レコードも上記 DELETE で
       消えるため、stale baseline の残留を防ぐ
   - 月初 cron (`0 0 1 * *`) は当月の `period` を渡して自動 recompute する
2. **Codex Phase 3 review HIGH #9 反映**: ベースライン採用の優先順位は次の通り:
   1. `count(driver_id × task_name) >= 5` → そのまま task baseline を使用
   2. それ未満で `count(driver_id, 全 task) >= 3` → driver-fallback baseline
      (`task_name = NULL`) を使用
   3. それ未満 → baseline 無し、`fare_deviation_high` 検出をスキップ
   - `anomaly_baselines.sample_size` には **実際に判定に使った baseline の
     サンプル数** を記録する（fallback 時は driver 全体の count）。
3. **Codex Phase 3 review CRITICAL #1 反映**: When 月次照合実行時に warning を
   生成する場合、the system shall **z-score** で判定する:
   - `deviation_sigma = abs(fare - median_fare) / sd_fare`
   - `deviation_sigma >= 2.0` (threshold) かつ `sd_fare > 0` で
     `fare_deviation_high` warning
   - `sd_fare == 0` (全件同額のサンプル) は判定スキップ
   - 旧仕様の "`(fare - median) / median` が ±2 SD を超えたら" という表現は
     単位不整合のため廃止
4. The system shall warning に以下のメタデータを構造化保存する:
   ```json
   {
     "type": "fare_deviation_high",
     "severity": "warn",
     "message": "運賃 30,000 円 (中央値 7,500 円から +18.75σ 乖離)",
     "data": {
       "fare": 30000,
       "median_fare": 7500,
       "sd_fare": 1200,
       "sample_size": 12,
       "baseline_scope": "task" | "driver_fallback",
       "deviation_sigma": 18.75,
       "threshold_sigma": 2.0
     }
   }
   ```
   `baseline_scope` で「task baseline」か「driver fallback」かを区別する。
5. The system shall `/api/anomaly-baselines/recompute?period=YYYY-MM` で
   手動再計算をトリガーできる。

### Requirement 2: 時刻矛盾と立替金整合性の検出 (F8-2)

**Objective:** 管理者として、dispatch_record / client_record の中に論理的に
ありえないデータ（集荷時刻 > 納品時刻、立替金あるのに明細無し等）が混入していたら
照合実行時に warning として可視化したい。

#### Acceptance Criteria

1. **Codex Phase 3 round 1 HIGH #11 / round 2 HIGH #3 反映**: When dispatch_record
   / client_record で `start_time > end_time` が成立する場合、the system shall
   以下のアルゴリズムで `time_inversion` warning を判定する:
   1. `HH:MM[:SS]` を 0〜1439 分に parse、parse 失敗は skip
   2. `start_min <= end_min` → 正常 (warning なし)
   3. `start_min > end_min` の場合は overnight 距離を算出:
      `overnight_distance = (1440 - start_min) + end_min`
   4. **`overnight_distance <= 720` → overnight 扱い (warning なし)**
   5. **`overnight_distance > 720` → `time_inversion` warning**
   - 境界 `720` は overnight 側に含める (例: `12:00 → 00:00` は overnight)
2. **Codex Phase 3 review MEDIUM #16 反映**: Phase 2 の
   `advance_payment_without_dispatch` (立替金あり + 未マッチ) は **維持** し、
   Phase 3 で **追加** で以下を実装する:
   - `advance_payment_without_label`: client_record `advance_payment > 0` だが
     matched dispatch_record の `task_name` に「立替」「実費」「立て替え」
     キーワードを含まない場合、info severity warning
3. **Codex round 1 HIGH #10 / round 2 MEDIUM #8 反映**: When 同 driver × 同日に
   3 件以上の dispatch_record が存在する場合、the system shall
   `dispatch_overload` warning を info severity で出力する。
   - 判定は reconciliation-job が事前に `dispatchCountByDriverDate:
     Map<string, number>` を集計して anomaly-detector に渡す
     (detector を純粋関数に保つ)
   - **count 対象は `getDispatchesForPeriod(period)` が返す period 内
     dispatch_records 全件** (matched / dispatch_only どちらの reconciliation 行か
     問わず、period に属する全 dispatch を count)
   - warning は `dispatch_only` 行・`matched` 行どちらにも出力する
     (同 driver × 同日が 3 件以上ある場合は全行に重複してマーク)
4. The system shall Phase 2 の `reconciliations.warnings` を JSON 配列のまま使い、
   1 行に複数 warning が並ぶケースを許容する。Web UI では severity 別に色分け表示する。

### Requirement 3: LINE 通知の基盤 (F9-1)

**Objective:** 管理者として、LINE 送信先 (User ID / Group ID / Room ID) を 1 度だけ
登録すれば、重要なイベント (月初リマインド / 照合完了 / 異常検出 / LLM 連続失敗) が
LINE Messaging API 経由で自動で push 通知される状態にしたい。Slack 等の追加 SaaS を
契約せず、Phase 1 で投入済みの `LINE_CHANNEL_ACCESS_TOKEN` を流用する。

#### Acceptance Criteria

1. The system shall `notification_settings` テーブル (単一行想定、`id=1` 固定) で
   以下を管理する:
   - `line_target_id` (TEXT) — 送信先の LINE ID:
     - User ID (`U` から始まる 33 文字): 管理者の個人 LINE に push
     - Group ID (`C` から始まる 33 文字): 運用専用グループに push
     - Room ID (`R` から始まる 33 文字): 複数ユーザーの room に push
     - null で通知無効化
   - `line_target_kind` (TEXT) — `'user' | 'group' | 'room'`、prefix 検証用
   - `enabled_events` (TEXT, JSON 配列): `['reconciliation_completed',
     'monthly_reminder', 'llm_parse_failed_streak']`
   - `last_test_at`, `last_error`, `updated_at`
   - **LINE_CHANNEL_ACCESS_TOKEN は wrangler secret で別管理** (Phase 1 のものを流用)
2. The system shall `/api/notification-settings` (GET / PUT) で管理画面から
   設定 + テスト送信を可能にする。設定保存時には対象 LINE 宛に
   「STEELO 通知設定が更新されました」というテストメッセージを push する。
   GET は target_id をマスク表示 (`U1234...abcd` のように先頭 5 + 末尾 4 のみ)、
   空文字または `null` でリセット可能。DELETE は対応しない (id=1 は常に存在、
   内容を空にすることで無効化)。
3. **Codex round 1 CRITICAL #4 / round 2 補強 反映**: The system shall LINE 投稿
   失敗時に audit_logs に記録し、management 画面でも「直近の投稿失敗」を表示する。
   - **fetch 自体の timeout は 1 回あたり 5 秒** (`AbortController` で abort)
   - retry は exponential backoff `sleep 1s → fetch 5s → sleep 3s → fetch 5s
     → sleep 8s → fetch 5s` = 最悪累積 **27 秒** で **`waitUntil` 30 秒制限内** に収まる
   - 上記 3 回でも失敗した場合、`notification_deliveries` 行は `status='pending'`
     のまま `attempt_count` を増やして `next_retry_at = now + 5 分` を設定
   - 次の cron `*/1` で再 claim → 再試行 (LINE 障害復旧後に自動再送)
   - `attempt_count >= 6` で `status='failed'` に倒し、`audit_logs` に
     `notification_send_failed` を記録
4. The system shall LINE_CHANNEL_ACCESS_TOKEN や target_id を
   `audit_logs.payload` に直接保存しない (secret + PII 相当)。ログには
   `notification_settings_updated` のような action のみ記録する。
   `last_error` には LINE API HTTP status と短い error message のみ記録
   (token を含む response body は記録しない)。

### Requirement 4: イベント別 LINE 通知ルール (F9-2)

**Objective:** 管理者として、4 種類のイベント発生時に LINE プッシュ通知が届く状態
にしたい。メッセージは LINE の text + Flex Message で見やすく整形されている。

#### Acceptance Criteria

1. When 月次照合ジョブが `completed` になった場合、the system shall
   以下を LINE push する:
   ```
   ✅ 2026-05 月の照合が完了しました
   matched: 87 / client_only: 3 / dispatch_only: 2
   ⚠️ 異常: fare_deviation_high 2 件 / time_inversion 1 件
   詳細: https://admin.example.com/reconciliations?period=2026-05
   ```
   text message として送信し、必要に応じて Flex Message で件数のカード表示を併用する。
2. When 異常検出ロジック (Requirement 1 / 2) で severity=warn の warning が
   1 件以上発生した場合、the system shall **照合完了通知に集約** して送信する
   (別メッセージにはしない、ノイズ対策)。
3. When 毎月 1 日 9:00 JST の cron で前月の confirmed `import_batch` が無い場合、
   the system shall「📋 前月 (2026-04) の元請け Excel がまだ取り込まれていません」
   というリマインドを LINE に push する。
4. When LLM 解析が直近 24 時間で 5 件連続失敗した場合、the system shall
   `llm_parse_failed_streak` 通知を LINE に push する
   (Anthropic API key 失効 / Anthropic 障害の早期発見)。
5. The system shall 各通知に `enabled_events` の対応キーが立っていない場合は送信
   スキップする。また `line_target_id` が null の場合も全通知をスキップする。
6. **Codex Phase 3 review HIGH #13 反映**: The system shall `notification_deliveries`
   テーブルで通知重複を防ぐ:
   - `monthly_reminder`: idempotency key = `monthly_reminder:{YYYY-MM}` (前月分)
   - `llm_parse_failed_streak`: key = `llm_failed_streak:{date_hour_bucket}` で
     **24 時間 cooldown** 中の再送をスキップ
   - `reconciliation_completed`: key = `reconciliation_completed:{job_id}` で
     job 1 回につき 1 通知
   - 重複検出時は `audit_logs` に skip 理由を記録

> **設計変更履歴**: 当初 Slack Incoming Webhook で実装する spec だったが、
> ユーザー判断で LINE Messaging API 直接送信に変更
> (`LINE_CHANNEL_ACCESS_TOKEN` 流用、新規 SaaS 不要、業務文脈 (ドライバー連絡も LINE)
> と一致、スマホ即見える)。Codex round 1-4 で Slack について指摘された設計事項
> (claim 機構 / payload schema バージョニング / waitUntil 制限 / event_payload_json /
> idempotency / fetch timeout 5s / retry 1s+3s+8s) は LINE 実装でも同様に適用する。

### Requirement 5: 月次レポート PDF 生成 (F10-1)

**Objective:** 管理者として、対象月を選択して 1 ボタンで以下 3 種の PDF を
生成・ダウンロードできる状態にしたい。元請けや経理に PDF をそのまま渡せる。

#### Acceptance Criteria

1. **Codex Phase 3 review LOW #20 反映**: When `/reports` 画面で対象月 +
   レポート種別を選択して「生成」を押した場合、the system shall 以下のいずれかを
   生成する。**実装順は P0 → P1 → P2** で段階的にリリースし、P0 完成で
   PDF 基盤の Workers 動作確認完了とする:
   - **P0: 照合結果レポート** (`reconciliation`): matched / client_only /
     dispatch_only の件数 + 異常 warning 一覧
   - **P1: 元請けサマリー** (`client_summary`): 取込済み client_records の
     合計売上、件数、ドライバー別小計
   - **P2: 支払明細サマリー** (`payment_summary`): 月次支払明細の総額、
     ドライバー別小計、控除内訳
2. The system shall PDF は A4 縦・日本語フォント（Noto Sans JP）で `pdf-lib` +
   `@pdf-lib/fontkit` ベースに生成し、ヘッダーに「STEELO 運送株式会社」+
   生成日時 + 対象月、フッターにページ番号を入れる。
3. **Codex Phase 3 review HIGH #14 反映**: The system shall 生成済み PDF を R2
   `STEELO_FILES` の `reports/{period}/{type}_{jobId}.pdf` に保存し、
   **Phase 1 の payment-summary と同じ authenticated proxy download**
   (`GET /api/reports/jobs/:id/download` で Bearer 必須、Worker が R2 から
   取得して bytes を直接ストリーミング) で配信する。R2 presigned URL は使わない
   (Phase 1 と方式統一)。
4. **Codex Phase 3 review CRITICAL #6 反映**: The system shall PDF 生成ジョブは
   `report_jobs` テーブルで非同期管理し、`queued` → `running` →
   `completed` / `failed` の状態を提供する。Phase 2 の `reconciliation_jobs`
   と同等の排他・復旧を実装する:
   - `active_report_key` generated column を `period || ':' || report_type` で作成、
     `status IN ('queued','running')` のときのみ値を持ち UNIQUE 制約
   - enqueue 失敗時は即 `failed` に倒す
   - cron `*/5 * * * *` で 30 分以上 `running` の job を `failed` にリカバリ
   - 同じ period × type を続けて生成したい場合は既存 job を完了させてから
5. **Codex round 1 MEDIUM #19 / round 2 HIGH #5 反映**: `report_jobs` は生成元
   データの identity をスナップショットとして保持し、**report_type ごとに必須
   source を持つ**。POST `/api/reports` 時点で該当 source が無ければ 422 で fail:
   - `reconciliation` (P0): **`source_reconciliation_job_id` 必須**
     (該当 period の最新 `status='completed'` reconciliation_jobs.id を解決)
   - `client_summary` (P1): **`source_import_batch_id` 必須**
     (該当 period の `status='confirmed'` import_batches の最新 id を解決)
   - `payment_summary` (P2): **`source_payment_job_id` 必須**
     かつ payment 系は既存テーブル (`driver_payment_summaries`) が upsert で
     上書きされる構造のため、Phase 3 では PDF 生成時に支払明細をその場で
     **payment-calculator から再計算** して使う (P2 は P0/P1 完了後に別途
     spec 化、Phase 3 では P2 は実装着手前に再評価)
   - レポート生成中の元データ更新が PDF に混ざらないよう、ジョブ開始時に
     対象 source ID を固定する。source 紐付け先が生成中に変更されても source
     ID を介して「ジョブ開始時点の snapshot」を読みに行く
6. While **P0** の照合結果レポート (1 ヶ月分・200 行規模) は 30 秒以内に完了する。
   500 行を超える大規模データは Phase 3 では `failed` に倒し
   `error_message: "row count exceeds 500"` で明示する (Phase 4 で分割対応)。

### Requirement 6: PDF テンプレート定義

**Objective:** 開発者として、PDF レイアウトをコードで定義し、デザイン変更時の
影響範囲を絞れる状態にしたい。

#### Acceptance Criteria

1. The system shall `services/pdf-templates/` 配下に各レポート種別ごとの
   `*.template.ts` を配置し、`render(data) → PDFDocument` 形式の純粋関数として
   実装する。
2. The system shall テンプレートのバージョンを `template_version` カラムに記録し、
   テンプレート変更時は bump して `report_jobs.template_version` に保存する
   （後から再生成して差分検証可能にする）。
3. **Codex Phase 3 review CRITICAL #3 反映**: The system shall 日本語フォント
   (`NotoSansJP-Regular.ttf`) を R2 に置き、`pdf-lib` で **custom font 埋込に
   必須の `@pdf-lib/fontkit` を併用** する:
   ```ts
   import fontkit from '@pdf-lib/fontkit';
   const pdf = await PDFDocument.create();
   pdf.registerFontkit(fontkit);
   const fontBytes = await STEELO_FILES.get('fonts/NotoSansJP-Regular.ttf')
     .then((r) => r!.arrayBuffer());
   const jpFont = await pdf.embedFont(fontBytes);
   ```
   起動時に `STEELO_FILES.get('fonts/...')` が null を返す場合、PDF 生成は即 `failed`
   に倒し `error_message: "font not found in R2"` を記録する。

### Requirement 7: 非機能要件

**Objective:** Phase 3 機能が Phase 1+2 の運用品質を維持しつつ追加されることを保証する。

#### Acceptance Criteria

1. The system shall Phase 1 + Phase 2 の全テスト (561 件) を維持する。Phase 3
   追加機能のテストは worker / db それぞれで unit + integration を備える。
2. **Codex Phase 3 review MEDIUM #17 反映**: The system shall PDF 生成を
   Cloudflare Workers の CPU 制限内 (30 秒) で完了させる。
   - bench fixture: 100 行 / 200 行 / 500 行で CPU time、生成 byte size、
     page count を計測する `pdf-generator.bench.ts`
   - **500 行超は fail with actionable error** (`row count exceeds 500`)。
     分割生成は Phase 4 で再検討
   - 5MB は **R2 上限ではなく業務上の警告閾値** として `warn` ログ出力のみ
3. **Codex Phase 3 review CRITICAL #5 反映**: The system shall Slack 通知の送信失敗が
   照合ジョブ等の本来のフローをブロックしないよう、**reconciliation-job からは
   Slack を直接呼ばず**、`notification_deliveries` テーブルに送信要求のみ
   永続化する。実際の Slack 投稿は別 cron (`*/1 * * * *` で
   `pending` 状態のレコードを拾って送信) または別 queue (Phase 4) で処理する。
4. The system shall PDF 生成バイナリサイズが 5MB を超える場合、警告ログを出すが、
   Phase 3 ではダウンロード自体は許可する (運用上の参考値)。Cloudflare Email Workers
   等のフォールバックは Phase 4 で再検討。
5. The system shall `audit_logs.action` に新規アクションを追加する:
   `anomaly_baseline_recompute` / `slack_notification_sent` / `slack_notification_failed` /
   `slack_notification_skipped` / `report_generated` / `notification_settings_updated`

### Requirement 8: データモデル拡張

**Objective:** Phase 3 で必要となる新規テーブルとカラム拡張を整理する。

#### Acceptance Criteria

1. The system shall migration `048_phase3_intelligence.sql` で以下を追加する:
   - **`anomaly_baselines`** (driver_id, task_name NULL 可, period_range,
     median_fare, sd_fare, sample_size, baseline_scope, computed_at)
     - **Codex Phase 3 review HIGH #8 反映**: UNIQUE 制約は partial index で実装:
       - `CREATE UNIQUE INDEX ux_anomaly_baselines_task ON anomaly_baselines (driver_id, task_name) WHERE task_name IS NOT NULL;`
       - `CREATE UNIQUE INDEX ux_anomaly_baselines_driver_all ON anomaly_baselines (driver_id) WHERE task_name IS NULL;`
   - **`notification_settings`** (id INTEGER PRIMARY KEY CHECK (id = 1),
     `line_target_id`, `line_target_kind` ('user' | 'group' | 'room'),
     enabled_events JSON, last_test_at, last_error, updated_at)
     - 行は migration で `INSERT OR IGNORE` で 1 行投入、DELETE は対応しない
     - LINE_CHANNEL_ACCESS_TOKEN は wrangler secret (Phase 1 のものを流用)
   - **`notification_deliveries`** (id PK, idempotency_key UNIQUE,
     event_type, status `pending|processing|sent|failed|skipped`, attempt_count,
     claimed_at, claimed_by, **`event_payload_json`** (Slack 構造体ではなく
     イベント生データ), **`payload_schema_ver`**, last_error, requested_at,
     sent_at, next_retry_at)
     - **Codex round 1 HIGH #13 反映**: 通知重複防止 + 再送キュー
     - **Codex round 2 HIGH #2 反映**: claim 機構で送信重複防止
     - **Codex round 2 MEDIUM #7 / round 3 HIGH #1 反映**: payload は Slack
       Block Kit ではなく event 生データを保存。送信時に `slack-notifier.ts` が
       `payload_schema_ver` を見て Block Kit を組み立てる (再送互換性確保)
   - **`report_jobs`** (id, period, report_type, status, template_version,
     r2_key, byte_size, page_count, source_import_batch_id NULL,
     source_reconciliation_job_id NULL, source_payment_job_id NULL,
     requested_by, requested_at, started_at, completed_at, error_message,
     `active_report_key` generated column)
     - `active_report_key` は `CASE WHEN status IN ('queued','running')
       THEN period || ':' || report_type END` で UNIQUE 制約
2. **Codex Phase 3 review CRITICAL #2 反映**: The system shall
   `reconciliations.warnings` の Schema は **TEXT のまま変更しない** が、
   中身を JSON 配列のまま要素構造を拡張する。後方互換のため
   `services/parse-warnings.ts:parseWarnings(raw)` ヘルパで吸収する:
   - 入力: `string | null` (DB から取得した JSON 文字列)
   - 戻り: `StructuredWarning[]`
   - 旧文字列配列 (`["fare_deviation: ...", ...]`) を検出した場合は
     `{type: 'legacy_warning', severity: 'info', message: <文字列>, data: {}}`
     に変換して返す（既知の prefix `fare_deviation:` `advance_payment_without_dispatch`
     はマッピングテーブルで個別の type に変換）
   - API レスポンス (`/api/reconciliations`) は Phase 3 以降 **常に
     `StructuredWarning[]`** で返す（混在しない契約）
3. The system shall Phase 2 の既存 `reconciliations` 行にも構造化 warning を
   遡及適用するための再計算スクリプトを `scripts/migrate-warnings.ts` で提供する
   （任意実行、未実行でも上記 `parseWarnings()` で読み出し互換性を保証）。
