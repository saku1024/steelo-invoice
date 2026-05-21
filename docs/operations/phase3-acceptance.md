# Phase 3 (Intelligence) 手動受入チェックリスト

Phase 3 (F8 異常検知強化 + F9 LINE 通知 + F10 月次 PDF レポート) を本番投入する前の
手動チェック。Phase 1 + Phase 2 のチェック
([`phase1-acceptance.md`](./phase1-acceptance.md) /
[`phase2-acceptance.md`](./phase2-acceptance.md)) を踏破済みの前提で追加項目を行う。

> **デプロイ手順そのもの** は [`deployment.md`](./deployment.md) を参照。
> 本ドキュメントは「動作確認シナリオ」を扱う。

## 0. 事前準備

- [ ] D1 migration `048_phase3_intelligence.sql` が適用済み
      `wrangler d1 execute line-crm --env production --remote --file=packages/db/migrations/048_phase3_intelligence.sql`
- [ ] Queues 作成済み: `report-queue` / `report-dlq`
      `wrangler queues create report-queue && wrangler queues create report-dlq`
- [ ] Cron triggers 4 個に増えていることを確認
      (`*/5 * * * *`, `0 */6 * * *`, `*/1 * * * *`, `0 0 1 * *`)
- [ ] R2 bucket `STEELO_FILES` の `fonts/NotoSansJP-Regular.ttf` に
      Noto Sans JP Regular TTF がアップロード済み
      ```
      wrangler r2 object put steelo-files/fonts/NotoSansJP-Regular.ttf \
        --file=NotoSansJP-Regular.ttf --env production
      ```
- [ ] LINE_CHANNEL_ACCESS_TOKEN は Phase 1 から既存 (再投入不要)
- [ ] Cloudflare Access Application に Phase 3 API パスを追加
      - `/api/anomaly-baselines/*`
      - `/api/notification-settings/*`
      - `/api/reports/*`
- [ ] STEELO_WEB_ORIGINS にダッシュボード URL を含めることを確認
      (LINE 通知のリンク先で使用)

---

## 1. F8: 異常検知強化

### 1.1 ベースライン自動再計算 (月初 cron)

- [ ] 月初 (1 日 9:00 JST = UTC 0:00) に anomaly-baseline-job が走る
- [ ] 過去 3 ヶ月の `client_records` (confirmed batch) から baseline 生成
- [ ] `wrangler tail` で以下のログ:
      ```
      [steelo] phase3 baseline recompute: period=2026-05, task=N, fallback=M, skipped=K
      ```
- [ ] `wrangler d1 execute line-crm --env production --remote \
        --command "SELECT COUNT(*) FROM anomaly_baselines"` で行数確認

### 1.2 手動 recompute

- [ ] curl で `POST /api/anomaly-baselines/recompute?period=2026-05` (Bearer 必須)
      → 200 + result (taskBaselines / driverFallbackBaselines / skippedDrivers / durationMs)
- [ ] `audit_logs` に `anomaly_baseline_recompute` 記録

### 1.3 構造化 warning

- [ ] 照合実行後、`reconciliations.warnings` に JSON 配列で構造化 warning が保存
      ```sql
      SELECT id, period, match_status, warnings FROM reconciliations
      WHERE warnings IS NOT NULL LIMIT 5;
      ```
- [ ] Phase 2 の文字列 warning が API レスポンスで構造化される
      (`/api/reconciliations` → `warnings: [{type, severity, message, data}]`)
- [ ] 5 種類の warning タイプが期待通り検出される:
  - `fare_deviation_high`: 中央値から ±2σ 外れる運賃
  - `time_inversion`: 終了時刻が開始時刻より前 (overnight 除外)
  - `advance_payment_without_dispatch`: 立替金あり + 未マッチ
  - `advance_payment_without_label`: 立替金あり + マッチ済み + dispatch に立替ラベルなし
  - `dispatch_overload`: 同 driver × 同日 3 件以上

---

## 2. F9: LINE 通知

### 2.1 通知設定

- [ ] `/api/notification-settings` GET (Bearer 必須) で
      `lineTargetIdMasked: null, enabledEvents: []` (初期状態)
- [ ] `/api/notification-settings` PUT で:
      ```json
      {
        "lineTargetId": "U1234...abcdef",
        "enabledEvents": ["reconciliation_completed", "monthly_reminder", "llm_parse_failed_streak"]
      }
      ```
      → 200 + マスク済み表示
- [ ] 設定後、1 分以内に LINE 宛にテスト通知が届く
      ("✅ TEST 月の照合が完了しました ..." の dummy payload)
- [ ] GET で `lineTargetIdMasked: "U1234...cdef"` のマスク表示
- [ ] `lineTargetId` 本体は API レスポンスに含まれない (PII 保護)
- [ ] 不正な ID (prefix が U/C/R 以外) で PUT → 400

### 2.2 4 種類のイベント通知

- [ ] **照合完了通知**: `/api/reconciliations/jobs` で照合実行 → 1 分以内に LINE 通知
      ```
      ✅ 2026-05 月の照合が完了しました
      matched: N / client_only: M / dispatch_only: K
      ⚠️ 異常: fare_deviation_high X 件 / ...
      詳細: https://admin.example.com/reconciliations?period=2026-05
      ```
- [ ] **月初リマインド**: 1 日 9:00 JST に前月 import_batch が未取込なら
      ```
      📋 前月 (2026-04) の元請け Excel がまだ取り込まれていません ...
      ```
- [ ] **LLM 連続失敗**: 直近 24h で `llm_parse_results.status='failed'` が 5 件以上
      かつ前回通知から 24h 経過していれば
      ```
      🚨 直近 24 時間で LLM 解析が N 件連続失敗しています ...
      ```
- [ ] **照合内の異常**: 異常 warning は照合完了通知に集約 (別メッセージにしない)

### 2.3 idempotency と claim 機構

- [ ] 同 job を 2 回 run しても 1 通知のみ
      (`idempotency_key = reconciliation_completed:{jobId}` UNIQUE)
- [ ] `wrangler d1 execute line-crm --env production --remote \
        --command "SELECT id, status, attempt_count, claimed_at FROM notification_deliveries \
        ORDER BY requested_at DESC LIMIT 10"` で状態確認
- [ ] 1 分粒度 cron で `pending` → `processing` → `sent` 遷移
- [ ] 同時複数 cron でも同 row は 1 つだけが claim される
      (status='processing' + claimed_by の atomic UPDATE ... RETURNING)
- [ ] LINE 5xx エラーで `attempt_count++` + `next_retry_at` セット → 次 cron で再試行
- [ ] `attempt_count >= 6` で `status='failed'`
- [ ] 10 分以上 processing の行は `*/1` cron で pending に戻る (stale recovery)

### 2.4 audit log

- [ ] `audit_logs.action` に以下が記録される:
  - `notification_settings_updated` (token / target_id 本体は含まれない、kind と
    masked のみ)
  - `notification_sent` (event_type / http_status / attempt_count)
  - `notification_failed` (event_type / http_status / reason)
  - `notification_skipped` (event_type / reason='not_enabled' or 'max_attempts')

### 2.5 手動テスト送信

- [ ] `POST /api/notification-settings/test` → 200 + deliveryId
- [ ] 1 分後に LINE 宛にテスト通知が届く

---

## 3. F10: 月次 PDF レポート

### 3.1 reconciliation report (P0) 生成

- [ ] 該当 period の reconciliation_job を完了させる
- [ ] `POST /api/reports/jobs` `{period: "2026-05", reportType: "reconciliation"}`
      → 202 + jobId
- [ ] `GET /api/reports/jobs/:id` で status が `queued` → `running` → `completed` に遷移
- [ ] 完了後の job レスポンスに `byteSize` / `pageCount` / `downloadUrl` が入る
- [ ] `GET /api/reports/jobs/:id/download` (Bearer 必須) で PDF をダウンロード
- [ ] PDF を開いて以下を目視確認:
  - ヘッダー「STEELO 運送株式会社」
  - 対象月 (例 "2026-05")
  - 生成日時
  - サマリーページ: matched / client_only / dispatch_only 件数
  - 異常検出ページ: warning type ごとの件数 (fare_deviation_high など)
  - 詳細ページ: driver / 日付 / task name の表
  - フッターにページ番号 (current / total)
  - 日本語が正しく描画されている (Noto Sans JP 埋込)

### 3.2 422 / 409 エラー

- [ ] reconciliation_job が無い period で POST → 422
      `{success: false, error: "required source not found for reconciliation in 2026-99"}`
- [ ] 同 period × type で 2 回 POST (1 回目が queued/running 中) → 409
      `{success: false, error: "active job exists for 2026-05:reconciliation"}`
- [ ] 完了後 (completed) の同 period × type は再生成可能

### 3.3 client_summary report (P1) は実装後に再確認

- [ ] Phase 3 では未実装 (P1 として後付け予定)
- [ ] POST `client_summary` → 422 (source 解決後の生成は failed with `not yet implemented`)

### 3.4 payment_summary は Phase 3 では未対応

- [ ] POST `payment_summary` → 500 / Error (実装着手前、Phase 4 で再評価)

### 3.5 性能・サイズ確認

- [ ] 200 行規模で 30 秒以内に生成完了
- [ ] PDF byte size が 5MB 以下 (業務閾値)
- [ ] 500 行を超えるデータは `failed` with `row count exceeds 500`
      (Phase 3 では分割せず明示 fail)

### 3.6 stuck recovery

- [ ] `running` で 30 分以上経過した job は cron `*/5` で `failed` に
- [ ] failed 後の同 period × type は再生成可能

---

## 4. 統合シナリオ (全機能連携)

### 4.1 月初の典型運用フロー

1. [ ] 1 日 9:00 JST に baseline 自動 recompute
2. [ ] 前月の元請け Excel が未取込なら LINE リマインド通知
3. [ ] 元請け Excel を取り込み (Phase 1) → confirm
4. [ ] `/reconciliations` で照合実行
5. [ ] 1 分以内に照合完了通知が LINE 到達 (matched/異常件数込み)
6. [ ] 異常 warning がある行を `/reconciliations` UI で確認
7. [ ] `/reports` で reconciliation PDF を生成 → 元請けへの月次報告として使う
8. [ ] 支払明細生成 (Phase 1) で xlsx を生成 → ドライバーへ配布

### 4.2 障害復旧シナリオ

- [ ] LINE_CHANNEL_ACCESS_TOKEN を失効させる:
      - 401 (auth) は **4xx 即 failed** (retry なし、token 復活で自動再送されない)。
        手動で `notification_deliveries.status='pending'` に戻す必要あり。
      - 500 / 503 / timeout 等は **5xx/timeout = retryable** で
        `next_retry_at +5 分` セット → token 復活後の cron で自動再送
- [ ] R2 bucket のフォントを削除 → report job 生成失敗 (FONT_NOT_FOUND)。
      フォント再アップロード後の再投入で成功
- [ ] Anthropic API key 失効 → LLM 解析失敗 → 5 件累積で LINE に
      llm_parse_failed_streak 通知

---

## 5. 完了判定

以下がすべて満たされたら Phase 3 本番投入完了と判定:

- [ ] §1〜3 の各機能チェックが全件 PASS
- [ ] §4 統合シナリオが期待通り
- [ ] 24 時間運用しても §2.4 audit_logs に error が大量発生しない
      (発生していたら原因調査、token / target_id / Anthropic 障害等)
- [ ] LINE 通知コストが想定範囲内
      (LINE Messaging API は無料枠 200 通/月、Phase 3 想定は月 4-10 通)

---

_最終更新: Phase 3 リリース時点。Phase 4 (機械学習スコア改善 / マルチテナント /
P2 payment_summary 再評価) を追加する時はこのドキュメントを更新すること。_
