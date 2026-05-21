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
  - `anomaly_baselines`, `notification_settings`（id=1 単一行 INSERT IGNORE 込み）,
    `report_jobs` を追加
  - 既存 `reconciliations.warnings` の Schema は変更しない
  - 観測可能完了条件: `pnpm db:migrate:local` で全テーブル作成、UNIQUE 制約 OK
  - _Requirements: 8.1_

- [ ] 1.2 共有型を `@line-crm/shared` に追加
  - `StructuredWarning`, `Baseline`, `NotificationSettings`, `ReportJob`,
    `ReportType` を定義
  - `AuditAction` に Phase 3 アクション 5 種を追加
  - 観測可能完了条件: worker / web 双方から型インポートできて typecheck パス
  - _Requirements: 7.5, 8.2_

- [ ] 1.3 `pdf-lib` 導入
  - `pnpm -F worker add pdf-lib` で追加
  - Noto Sans JP TTF を `apps/worker/assets/fonts/` に置く（R2 へは手動 upload）
  - 観測可能完了条件: typecheck 成功、wrangler dev 起動 OK
  - _Requirements: 5.2, 6.3_

---

## 2. F8 異常検知強化

- [ ] 2.1 `services/anomaly-detector.ts` を純粋関数で実装
  - 4 種類の warning タイプ（fare_deviation_high / time_inversion /
    advance_payment_without_label / dispatch_overload）
  - baseline Map lookup + ±2 SD 判定
  - 時刻矛盾は 12 時間以内かどうかで日跨ぎ判別
  - 観測可能完了条件: 10+ ユニットテスト（境界ケース網羅）
  - _Requirements: 1.3-1.4, 2.1-2.4_

- [ ] 2.2 `services/anomaly-baseline-job.ts` を実装
  - 過去 3 ヶ月の `client_records` (confirmed batch) を集計
  - driver_id × task_name 単位で median + SD 計算（サンプル数 < 5 はフォールバック）
  - `anomaly_baselines` に UPSERT
  - 観測可能完了条件: 1 ヶ月分のテストデータで baseline が正しく計算される
  - _Requirements: 1.1-1.2, 1.5_

- [ ] 2.3 `db/anomaly-baselines.ts` クエリ関数
  - `upsertBaseline()`, `getBaselineMap(driverId?)`, `clearBaselines()`
  - 観測可能完了条件: 5 ユニットテスト
  - _Requirements: 8.1_

- [ ] 2.4 `services/reconciliation.ts` を構造化 warning に切替
  - `collectWarnings()` の戻り値を `string[]` から `StructuredWarning[]` に
  - `anomaly-detector.ts` を呼び出すように変更
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
    `recordSendError()`
  - Slack URL マスク表示用ヘルパ
  - 観測可能完了条件: 4 ユニットテスト
  - _Requirements: 3.1, 8.1_

- [ ] 3.2 `services/slack-notifier.ts` を実装
  - `sendSlackNotification()`: fetch + exp backoff retry
  - `buildReconciliationCompletedMessage()`: Block Kit JSON 組立
  - `buildMonthlyReminderMessage()`, `buildLLMFailureStreakMessage()`
  - 観測可能完了条件: モック fetch で 6 ユニットテスト
  - _Requirements: 3.3, 4.1-4.5_

- [ ] 3.3 `routes/notification-settings.ts` を実装
  - GET (mask URL), PUT (validate + テスト投稿)
  - POST /test で手動テスト送信
  - 観測可能完了条件: 手動 curl で設定保存 → Slack 到達確認
  - _Requirements: 3.2, 3.4_

- [ ] 3.4 `services/reconciliation-job.ts` に Slack 通知統合
  - completed 後に notifyReconciliationCompleted を waitUntil で fire-and-forget
  - 観測可能完了条件: ローカルで照合実行 → Slack 通知が来る
  - _Requirements: 4.1-4.2, 7.3_

- [ ] 3.5 `index.ts` scheduled に月初リマインド追加
  - cron `0 0 1 * *` (JST 9 時 = UTC 0 時) で前月確認
  - 過去 1 ヶ月の confirmed import_batch が無ければリマインド
  - 観測可能完了条件: scheduled テストで該当 / 非該当のパス両方確認
  - _Requirements: 4.3_

- [ ] 3.6 LLM 解析 5 件連続失敗の検知
  - `index.ts` scheduled で `llm_parse_results.status='failed'` の直近 24h を集計
  - 5 件以上連続 (順序) で Slack 通知
  - 観測可能完了条件: テストで 4 件失敗 → 通知無し、5 件失敗 → 通知有り
  - _Requirements: 4.4_

- [ ] 3.7 (P) Web `/settings/notifications/page.tsx`
  - Slack URL 入力（マスク表示、PUT で更新）
  - イベント checkbox 一覧
  - 「テスト投稿」ボタン
  - 直近のエラー表示
  - 観測可能完了条件: 設定保存 → Slack 到達、UI で結果反映
  - _Requirements: 3.2_

---

## 4. F10 月次レポート PDF

- [ ] 4.1 Noto Sans JP TTF を R2 にアップロード
  - 手動: `wrangler r2 object put steelo-files/fonts/NotoSansJP-Regular.ttf --file=...`
  - 起動時に `STEELO_FILES.get('fonts/NotoSansJP-Regular.ttf')` で取得確認
  - 観測可能完了条件: 起動時にフォントが取得できる
  - _Requirements: 6.3_

- [ ] 4.2 (P) `services/pdf-templates/client-summary.ts`
  - データ取得は別関数（テンプレートは純粋関数）
  - A4 縦、ヘッダー + フッター + ドライバー別小計テーブル
  - 観測可能完了条件: snapshot test で page 数 + フォント埋込確認
  - _Requirements: 5.1-5.2, 6.1_

- [ ] 4.3 (P) `services/pdf-templates/reconciliation-report.ts`
  - matched / client_only / dispatch_only の 3 タブを 3 ページに
  - warnings 一覧ページ
  - 観測可能完了条件: 200 行データで生成成功
  - _Requirements: 5.1, 6.1_

- [ ] 4.4 (P) `services/pdf-templates/payment-summary.ts`
  - 既存 payment-summary 機能のデータを PDF 化
  - ドライバー別 + 控除内訳
  - 観測可能完了条件: 200 行データで生成成功
  - _Requirements: 5.1, 6.1_

- [ ] 4.5 `services/pdf-generator.ts`
  - フォント取得 + テンプレート呼出 + serialize
  - エラー時の error_message 整形
  - 観測可能完了条件: 3 種テンプレート全て生成成功、巨大 (500 行) でも 30s 以内
  - _Requirements: 5.5, 7.2_

- [ ] 4.6 `db/report-jobs.ts` クエリ関数
  - createJob, tryMarkRunning, markCompleted/Failed
  - listByPeriod
  - 観測可能完了条件: 5 ユニットテスト
  - _Requirements: 5.4, 8.1_

- [ ] 4.7 `services/report-job.ts` consumer
  - データ取得 → pdf-generator 呼出 → R2 PUT → markCompleted
  - 失敗時 markFailed
  - 観測可能完了条件: e2e で R2 にバイナリが置かれる
  - _Requirements: 5.3-5.4_

- [ ] 4.8 `routes/reports.ts` を実装
  - POST /api/reports { period, report_type }
  - GET /api/reports/jobs/:id
  - GET /api/reports/jobs/:id/download → 15 分 signed URL
  - 観測可能完了条件: e2e で生成 → ダウンロード成功
  - _Requirements: 5.1, 5.3_

- [ ] 4.9 (P) Web `/reports/page.tsx`
  - 月選択 + 3 種類の生成ボタン
  - ジョブステータスのポーリング表示
  - 完了後にダウンロードボタン
  - 観測可能完了条件: 3 種類全て生成 → ダウンロード可能
  - _Requirements: 5.1_

- [ ] 4.10 (P) sidebar.tsx に「レポート出力」「通知設定」を追加
  - 観測可能完了条件: ナビから両画面に遷移可能
  - _Requirements: 3.2, 5.1_

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
  - Phase 3 デプロイ手順を追記（D1 048 適用、フォント R2 アップロード、
    Slack URL 投入手順）
  - 観測可能完了条件: deployment.md の Phase 3 セクションが完成
  - _Requirements: 7.1_

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
