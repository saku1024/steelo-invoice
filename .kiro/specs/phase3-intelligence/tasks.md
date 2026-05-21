# Implementation Plan — Phase 3 Intelligence

`requirements.md`（8 要件）と `design.md` に基づく実装タスク。
Foundation → F8 → F9 → F10 → Validation の順、`(P)` で並列実行可能を示す。

実装の順序は **F8 → F9 → F10 を推奨**:
- F8 (異常検知強化) は照合エンジンの構造化 warning 拡張で、他機能の前提
- F9 (Slack) は F8 の warning を消費する最初の通知先
- F10 (PDF) は独立しているが、F8 の構造化 warning を使うと表示が綺麗になる

---

## 1. Foundation

- [ ] 1.1 D1 マイグレーション `048_phase3_intelligence.sql`
  - `anomaly_baselines` (partial unique index 込み、Codex HIGH #8),
    `notification_settings`（id=1 単一行 INSERT IGNORE 込み）,
    `notification_deliveries` (idempotency_key UNIQUE、Codex HIGH #13),
    `report_jobs` (active_report_key generated col + UNIQUE、source_*_id FK、
    Codex CRITICAL #6 / MEDIUM #19) を追加
  - 既存 `reconciliations.warnings` の Schema は変更しない
  - 観測可能完了条件: `pnpm db:migrate:local` で全テーブル作成、partial UNIQUE で
    `task_name=NULL` 二重 INSERT が拒否される、active_report_key で同 period × type
    二重投入が拒否される
  - _Requirements: 8.1_

- [ ] 1.2 共有型を `@line-crm/shared` に追加
  - `StructuredWarning`, `WarningType`, `Baseline`, `AnomalyContext`,
    `NotificationSettings`, `NotificationDelivery`, `ReportJob`, `ReportType` を定義
  - `AuditAction` に Phase 3 アクション 6 種を追加
    (anomaly_baseline_recompute / slack_notification_sent / slack_notification_failed /
     slack_notification_skipped / report_generated / notification_settings_updated)
  - 観測可能完了条件: worker / web 双方から型インポートできて typecheck パス
  - _Requirements: 7.5, 8.2_

- [ ] 1.3 `pdf-lib` + `@pdf-lib/fontkit` 導入 (Codex CRITICAL #3)
  - `pnpm -F worker add pdf-lib @pdf-lib/fontkit` で両方追加
  - Noto Sans JP TTF をリポジトリに含めず、R2 に直接アップロード手順を
    deployment.md に記載
  - `pdfDoc.registerFontkit(fontkit)` を `pdf-generator.ts` のテンプレで先に呼ぶ
  - 観測可能完了条件: typecheck 成功、wrangler dev でフォントが取得できる
  - _Requirements: 5.2, 6.3_

- [ ] 1.4 STEELO_PATH_PREFIXES に Phase 3 ルート追加 (Codex HIGH #12)
  - `apps/worker/src/middleware/steelo-cors.ts` の `STEELO_PATH_PREFIXES` に
    `/api/reports`, `/api/notification-settings`, `/api/anomaly-baselines` を追加
  - CORS unit test に Phase 3 prefix が許可 origin 限定であることを確認
  - 観測可能完了条件: 既存 `steelo-cors.test.ts` に Phase 3 用ケース追加 + 緑

- [ ] 1.5 REPORT_QUEUE (新規) と report-dlq を追加 (Codex CRITICAL #7)
  - `wrangler.toml` に producer + consumer + dead_letter_queue 設定
  - default + production 両方
  - 観測可能完了条件: `wrangler dev` で `REPORT_QUEUE` バインディング警告なし

- [ ] 1.6 services/parse-warnings.ts (Codex CRITICAL #2)
  - `parseWarnings(raw)` / `serializeWarnings(warnings)` を実装
  - 旧 `string[]` の legacy prefix mapping (`fare_deviation:` → 構造化等)
  - 観測可能完了条件: 6 ユニットテスト (旧 / 新 / null / 不正 JSON 等)

---

## 2. F8 異常検知強化

- [ ] 2.1 `services/anomaly-detector.ts` を純粋関数で実装
  - 5 種類の warning タイプ:
    - fare_deviation_high (z-score `abs(fare-median)/sd >= 2`、Codex CRITICAL #1)
    - time_inversion (分単位 0-1439 parse、overnight 720 分境界、Codex HIGH #11)
    - advance_payment_without_dispatch (Phase 2 維持)
    - advance_payment_without_label (Phase 3 新規、Codex MEDIUM #16)
    - dispatch_overload (precomputed Map から判定、Codex HIGH #10)
  - 観測可能完了条件: 12+ ユニットテスト（境界ケース網羅）
  - _Requirements: 1.3-1.4, 2.1-2.4_

- [ ] 2.2 `services/anomaly-baseline-job.ts` を実装
  - 過去 3 ヶ月の `client_records` (confirmed batch) を集計
  - driver_id × task_name 単位で median + SD 計算
  - **fallback 優先順位 (Codex HIGH #9)**:
    1. `count(driver × task) >= 5` → `baseline_scope='task'`
    2. それ未満で `count(driver, 全 task) >= 3` → `baseline_scope='driver_fallback'`
       (task_name = NULL の partial unique index 行で INSERT)
    3. それ未満 → INSERT しない (baseline 無し扱い)
  - `sample_size` には実際の判定対象数を記録
  - 観測可能完了条件: 1 ヶ月分のテストデータで全 3 ケースの境界が正しく動く
  - _Requirements: 1.1-1.2, 1.5_

- [ ] 2.3 `db/anomaly-baselines.ts` クエリ関数
  - `upsertBaseline()`, `getBaselineMap(driverId?)`, `clearBaselines()`
  - 観測可能完了条件: 5 ユニットテスト
  - _Requirements: 8.1_

- [ ] 2.4 `services/reconciliation.ts` を構造化 warning に切替
  - `collectWarnings()` の戻り値を `string[]` から `StructuredWarning[]` に
  - `anomaly-detector.ts` を呼び出す
  - `reconciliation-job.ts` で事前に `dispatchCountByDriverDate: Map<string, number>`
    を集計し AnomalyContext に渡す (Codex HIGH #10)
  - 書き込みは serializeWarnings()、API レイヤーは parseWarnings() 経由 (Codex CRITICAL #2)
  - 既存テストを更新（warning 配列の比較が変わる）
  - 観測可能完了条件: Phase 2 のテスト 17 件が新フォーマットで全件緑
  - _Requirements: 2.4, 8.3_

- [ ] 2.5 `routes/anomaly-baselines.ts` を実装
  - POST /api/anomaly-baselines/recompute?period=YYYY-MM
  - GET /api/anomaly-baselines （現状のベースライン一覧）
  - 観測可能完了条件: 手動 curl で動作確認
  - _Requirements: 1.5_

- [ ] 2.6 (P) Web `/reconciliations` UI 拡張
  - warnings を severity 別に色分け表示 (warn=赤 / info=黄)
  - warning タイプ別フィルタ
  - 観測可能完了条件: Next.js build 成功、各 warning が UI で確認できる
  - _Requirements: 2.4_

- [ ] 2.7 既存 warnings の構造化スクリプト
  - `scripts/migrate-warnings.ts` で Phase 2 の文字列配列を構造化に変換
  - 任意実行（未実行でも新 warning は構造化される）
  - 観測可能完了条件: dry-run + 1 期間分の変換成功
  - _Requirements: 8.3_

---

## 3. F9 Slack 通知

- [ ] 3.1 `db/notification-settings.ts` クエリ関数
  - `getSettings()`, `updateSettings()`, `recordTestResult()`,
    `recordSendError()` (URL は含めない)
  - Slack URL マスク表示用ヘルパ
  - 観測可能完了条件: 4 ユニットテスト

- [ ] 3.2 `db/notification-deliveries.ts` クエリ関数 (Codex HIGH #13)
  - `enqueue(key, eventType, payloadJson)` (INSERT OR IGNORE で重複防止)
  - `listPending(limit, now)` (next_retry_at <= now)
  - `markSent(id)` / `markFailed(id, lastError)` / `markSkipped(id, reason)`
  - `incrementAttempt(id, nextRetryAt)` (5xx retry 用)
  - 観測可能完了条件: 5 ユニットテスト

- [ ] 3.3 `services/slack-notifier.ts` を実装 (Codex CRITICAL #4)
  - `sendSlackNotification()`: fetch + exp backoff **1s + 3s + 8s = 12s 以内**
  - `buildReconciliationCompletedMessage()`: Block Kit JSON 組立
  - `buildMonthlyReminderMessage()`, `buildLLMFailureStreakMessage()`
  - URL は last_error に含めない (HTTP status + path 末尾 `/services/***/***/***`)
  - 観測可能完了条件: モック fetch で 6 ユニットテスト (200/4xx/5xx/timeout/累積時間)

- [ ] 3.4 `services/slack-dispatcher.ts` cron consumer (Codex CRITICAL #5)
  - 1 分粒度 cron で `notification_deliveries.status='pending'` を 10 件単位処理
  - 4xx → status=failed、5xx → attempt_count++ + next_retry_at += 5min
  - 累積 attempt が 6 を超えたら status=failed
  - 観測可能完了条件: 統合テストで pending → sent / failed 両方

- [ ] 3.5 `routes/notification-settings.ts` を実装
  - GET (mask URL), PUT (URL + enabled_events 更新 → テスト投稿 enqueue)
  - POST /test で手動テスト送信 (notification_deliveries にエンキュー)
  - 観測可能完了条件: 手動 curl で設定保存 → 1 分後に Slack 到達確認

- [ ] 3.6 `services/reconciliation-job.ts` に通知エンキュー統合
  - completed 後に `notification_deliveries` に INSERT のみ
    (Slack 直接呼び出ししない、Codex CRITICAL #5)
  - idempotency_key = `reconciliation_completed:{jobId}`
  - 観測可能完了条件: ローカルで照合実行 → 1 分後に Slack 通知が来る
  - _Requirements: 4.1-4.2, 7.3_

- [ ] 3.7 `index.ts` scheduled に月初リマインド追加
  - cron `0 0 1 * *` (JST 9 時 = UTC 0 時) で前月確認
  - 過去 1 ヶ月の confirmed import_batch が無ければ `notification_deliveries`
    にエンキュー (idempotency_key = `monthly_reminder:{prev_period}`)
  - 観測可能完了条件: scheduled テストで該当 / 非該当 + 重複エンキュー防止確認
  - _Requirements: 4.3, 4.6_

- [ ] 3.8 LLM 解析 5 件連続失敗の検知
  - `index.ts` scheduled で `llm_parse_results.status='failed'` の直近 24h を集計
  - 5 件以上連続 (順序) でエンキュー
    (idempotency_key = `llm_failed_streak:{date_hour_bucket}`、24h cooldown)
  - 観測可能完了条件: テストで 4 件 → 通知無し、5 件 → 1 通知、12 件 → 1 通知
  - _Requirements: 4.4, 4.6_

- [ ] 3.9 (P) Web `/settings/notifications/page.tsx`
  - Slack URL 入力（マスク表示、PUT で更新）
  - イベント checkbox 一覧
  - 「テスト投稿」ボタン (deliveries にエンキュー → 1 分後に届く旨表示)
  - 直近のエラー表示
  - 観測可能完了条件: 設定保存 → Slack 到達、UI で結果反映
  - _Requirements: 3.2_

---

## 4. F10 月次レポート PDF

**P0 → P1 → P2 の段階的実装 (Codex LOW #20)**:
P0 (reconciliation) で PDF 基盤の Workers 動作を確認、その後 P1 / P2 を追加。

- [ ] 4.1 Noto Sans JP TTF を R2 にアップロード
  - 手動: `wrangler r2 object put steelo-files/fonts/NotoSansJP-Regular.ttf --file=...`
  - deployment.md に手順を追記
  - 起動時に `STEELO_FILES.get('fonts/NotoSansJP-Regular.ttf')` で取得確認
  - 観測可能完了条件: 起動時にフォントが取得できる
  - _Requirements: 6.3_

- [ ] 4.2 `services/pdf-generator.ts` 基盤 (P0 と同時)
  - `pdfDoc.registerFontkit(fontkit)` 必須 (Codex CRITICAL #3)
  - フォント取得 + テンプレート呼出 + serialize
  - エラー時の error_message 整形 ("font not found in R2" / "row count exceeds 500")
  - 観測可能完了条件: P0 テンプレで生成成功、500 行で fail
  - _Requirements: 5.5, 7.2_

- [ ] 4.3 **P0**: `services/pdf-templates/reconciliation-report.ts`
  - matched / client_only / dispatch_only の 3 タブを 3 ページに
  - warnings 一覧ページ (parseWarnings 経由で structured 表示)
  - 観測可能完了条件: 200 行データで生成成功、construct test で page count /
    expected text / footer 番号確認 (Codex MEDIUM #18)
  - _Requirements: 5.1, 6.1_

- [ ] 4.4 `db/report-jobs.ts` クエリ関数 (Phase 2 reconciliation_jobs パターン踏襲)
  - createJob (active_report_key UNIQUE 違反で 409)
  - tryMarkRunning, markCompleted (byte_size + page_count + r2_key 込み),
    markFailed, recoverStuck (Codex CRITICAL #6)
  - listByPeriod, get
  - source_*_id をジョブ開始時に保存 (Codex MEDIUM #19)
  - 観測可能完了条件: 6 ユニットテスト (排他 / リカバリ / source 保存)
  - _Requirements: 5.4, 5.5, 8.1_

- [ ] 4.5 `services/report-job.ts` consumer
  - tryMarkRunning → source 確定 → データ取得 (parseWarnings 経由) →
    pdf-generator 呼出 → R2 PUT → markCompleted
  - 失敗時 markFailed
  - 観測可能完了条件: P0 で e2e (R2 に bytes が置かれる)
  - _Requirements: 5.3-5.4_

- [ ] 4.6 `routes/reports.ts` を実装 (Codex HIGH #14: Bearer proxy DL)
  - POST /api/reports { period, report_type } → 202 + jobId
    (UNIQUE 違反は 409、REPORT_QUEUE.send 失敗時は即 failed)
  - GET /api/reports/jobs/:id → 状態取得
  - **GET /api/reports/jobs/:id/download** → Bearer 必須、R2 から取得して
    bytes を Content-Disposition で直接ストリーミング (presigned URL 使わない、
    Phase 1 payment-summary と方式統一)
  - 観測可能完了条件: 各 HTTP コード (202/400/404/409) + DL 動作確認

- [ ] 4.7 `pdf-generator.bench.ts` (Codex MEDIUM #17)
  - 100 行 / 200 行 / 500 行で CPU time + byte size + page count を出力
  - target: 200 行 < 5s、500 行 < 30s 達成確認
  - 観測可能完了条件: bench 全 3 ケース pass、CI で実行

- [ ] 4.8 (P1) `services/pdf-templates/client-summary.ts`
  - 取込済み client_records の合計売上、件数、ドライバー別小計
  - 観測可能完了条件: 200 行データで生成成功

- [ ] 4.9 (P2) `services/pdf-templates/payment-summary.ts`
  - 月次支払明細の総額、ドライバー別小計、控除内訳
  - 観測可能完了条件: 200 行データで生成成功

- [ ] 4.10 Web `/reports/page.tsx`
  - 月選択 + 種別ボタン (P0 のみ初版、P1 / P2 は後付け)
  - ジョブステータスのポーリング表示
  - 完了後にダウンロードボタン (Bearer 付き fetch + Blob URL)
  - 観測可能完了条件: P0 で生成 → ダウンロード可能

- [ ] 4.11 (P) sidebar.tsx に「レポート出力」「通知設定」を追加
  - 観測可能完了条件: ナビから両画面に遷移可能

---

## 5. Validation

- [ ] 5.1 統合テスト追加
  - reconciliation job → 構造化 warning → Slack 通知
  - report job → R2 PUT → ダウンロード URL 生成
  - notification settings: PUT → テスト投稿 → audit_logs 記録
  - 観測可能完了条件: 既存 561 件 + Phase 3 追加分が全件緑
  - _Requirements: 7.1_

- [ ] 5.2 CI workflow 更新
  - .github/workflows/steelo-bench.yml に Phase 3 のテスト追加
  - 観測可能完了条件: PR で全テストが走る
  - _Requirements: 7.1_

- [ ] 5.3 受入チェックリスト追加
  - docs/operations/phase3-acceptance.md を新規作成
  - F8 / F9 / F10 各機能の手動受入手順を記載
  - 観測可能完了条件: チェックリストがリポジトリに存在
  - _Requirements: 7.5_

- [ ] 5.4 deployment.md 更新
  - Phase 3 デプロイ手順を追記:
    - D1 migration 048 適用
    - フォント R2 アップロード (NotoSansJP-Regular.ttf)
    - REPORT_QUEUE + report-dlq 作成
    - Cloudflare Access に Phase 3 API パス追加 (/api/reports/*,
      /api/notification-settings/*, /api/anomaly-baselines/*)
    - Slack Incoming Webhook URL の取得 → 管理画面で投入手順
  - 観測可能完了条件: deployment.md の Phase 3 セクションが完成
  - _Requirements: 7.1_

- [ ] 5.5 spec 再レビュー (推奨)
  - Codex に修正版 spec を再レビューに通す
  - CRITICAL 残ゼロを確認してから実装着手
  - 観測可能完了条件: 再レビュー結果が `0 CRITICAL` で実装 gate 通過

---

## カバレッジ確認

- Requirement 1 (運賃ベースライン): tasks 1.1, 1.2, 2.1-2.3, 2.5
- Requirement 2 (時刻矛盾 / 立替金 / overload): tasks 2.1, 2.4, 2.6
- Requirement 3 (Slack 基盤): tasks 1.1, 1.2, 3.1, 3.2, 3.3, 3.7
- Requirement 4 (Slack イベント別): tasks 3.4, 3.5, 3.6
- Requirement 5 (PDF レポート): tasks 4.1-4.10
- Requirement 6 (PDF テンプレート): tasks 4.2-4.5
- Requirement 7 (非機能): tasks 1.2, 4.5, 5.1-5.4
- Requirement 8 (データモデル): tasks 1.1, 1.2, 2.7

全要件 ID が少なくとも 1 タスクに対応していることを確認済み。

---

## 規模見積もり

| カテゴリ | 概算ファイル数 | 概算行数 |
|---|---|---|
| Migration + 共有型 | 2 | 200 |
| F8 (anomaly) | 6 (service / job / db / route / web / test) | 800 |
| F9 (Slack) | 7 (service / db / route / web / scheduled / test) | 900 |
| F10 (PDF) | 8 (3 templates / generator / job / db / route / web) | 1500 |
| Validation | 4 (test / CI / doc) | 600 |
| **合計** | **27 ファイル** | **約 4000 行** |

Phase 1 (約 8000 行) / Phase 2 (約 5000 行) と比較すると、Phase 3 は中規模。
PDF テンプレートが最大の作業量を占める。
