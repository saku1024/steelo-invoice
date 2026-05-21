# STEELO 本番デプロイ手順書

Phase 1 (支払明細半自動化) + Phase 2 (LLM 解析 + 自動照合) + Phase 3
(異常検知強化 + LINE 通知 + 月次 PDF レポート) を Cloudflare 本番環境に投入する手順。
**新規環境への初回デプロイ** と **既存環境への追加デプロイ** の両方をカバーする。
各ステップを順番に実行し、チェックボックスを埋めてから次に進むこと。

このドキュメントは「実行手順」のみを書く。各機能の振る舞い確認は
[`phase1-acceptance.md`](./phase1-acceptance.md) /
[`phase2-acceptance.md`](./phase2-acceptance.md) /
[`phase3-acceptance.md`](./phase3-acceptance.md)
を参照。

---

## 0. 前提条件

- [ ] Cloudflare アカウントを作成済み、Workers Paid プラン (Queues 利用に必須)
- [ ] 管理用ドメイン (例: `admin.example.com`) を Cloudflare DNS で管理済み
- [ ] Workers 用ドメイン (例: `worker.example.com`) を同様に管理済み
- [ ] Anthropic Console で API key を発行済み (Phase 2 で必要)
- [ ] LINE Developers Console で Messaging API channel を発行済み
- [ ] ローカルに `wrangler` CLI をインストール済み (`npm install -g wrangler`)
- [ ] `wrangler login` 完了済み

---

## 1. Cloudflare リソース作成（初回のみ）

### 1.1 D1 データベース

- [ ] D1 データベースを作成
  ```sh
  wrangler d1 create line-crm
  ```
  → 出力された `database_id` を控える。

- [ ] `apps/worker/wrangler.toml` の `[env.production.d1_databases]` セクション内
      `database_id = "YOUR_D1_DATABASE_ID"` を実際の ID に置き換え
- [ ] `account_id = "YOUR_ACCOUNT_ID"` を Cloudflare ダッシュボードに表示される
      Account ID に置き換え

### 1.2 R2 バケット

- [ ] STEELO 用 R2 バケットを作成
  ```sh
  wrangler r2 bucket create steelo-files
  ```
- [ ] 既存 LINE Harness 用バケットも未作成なら作成
  ```sh
  wrangler r2 bucket create line-harness-images
  ```

### 1.3 Queues（5 本）

- [ ] Phase 1 のキュー
  ```sh
  wrangler queues create payment-job-queue
  ```
- [ ] Phase 2 のキュー（DLQ 含む）
  ```sh
  wrangler queues create llm-parse-queue
  wrangler queues create llm-parse-dlq
  wrangler queues create reconciliation-queue
  wrangler queues create reconciliation-dlq
  ```

> Queues 未契約環境では Scheduled Worker (`*/5 * * * *`) が fallback として
> queued 状態のジョブを拾うため、Queues なしでも動くが推奨は Queues 利用。

---

## 2. シークレット投入（本番環境）

- [ ] LINE Messaging API
  ```sh
  cd apps/worker
  wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env production
  wrangler secret put LINE_CHANNEL_SECRET --env production
  ```

- [ ] STEELO 管理画面 API キー（Bearer 認証用、任意の strong random string）
  ```sh
  openssl rand -hex 32  # 生成例
  wrangler secret put API_KEY --env production
  ```
  → このキーは Web 管理画面の "API キー" 入力欄に貼る。

- [ ] **Phase 2**: Anthropic API key
  ```sh
  wrangler secret put ANTHROPIC_API_KEY --env production
  ```
  → `sk-ant-api03-...` を投入。未設定だと LLM 解析が起動時に skip され、
  `dispatch_records` は手動入力に戻る（Webhook 受信は継続）。

- [ ] CORS 許可 origin（vars でも secret でも可、改竄リスク低いので `vars` 推奨）
  ```toml
  # wrangler.toml の [env.production.vars] に追記
  [env.production.vars]
  STEELO_WEB_ORIGINS = "https://admin.example.com"
  ```

### 投入確認

- [ ] 全シークレットが登録されているか確認
  ```sh
  wrangler secret list --env production
  ```
  → `API_KEY` `LINE_CHANNEL_ACCESS_TOKEN` `LINE_CHANNEL_SECRET` `ANTHROPIC_API_KEY`
  の 4 つが表示されればよい。

---

## 3. D1 マイグレーション適用

順番に実行。**046 → 047** の順を厳守。

- [ ] Phase 1 schema を本番 D1 に適用
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --file=packages/db/migrations/046_steelo_phase1.sql
  ```

- [ ] Phase 2 schema を追加適用
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --file=packages/db/migrations/047_phase2_reconciliation.sql
  ```

- [ ] テーブルが揃っているか確認
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ```
  → 想定: `audit_logs` / `client_records` / `dispatch_records` / `driver_aliases` /
  `driver_deductions` / `drivers` / `import_batches` / `line_messages` /
  `llm_parse_results` / `payment_jobs` / `payment_summaries` /
  `reconciliation_jobs` / `reconciliations` 等。

---

## 4. Cloudflare Access 設定

Web 管理画面と STEELO API は Cloudflare Access で多層防御する。詳細は
[`cloudflare-access.md`](./cloudflare-access.md) を参照。最低限のチェックリストのみ:

- [ ] Dashboard → Zero Trust → Access → Applications で Application を作成
- [ ] Type: `Self-hosted`
- [ ] Application domain: 管理画面のドメイン（例: `admin.example.com`）
- [ ] **Phase 2 で追加された API パスも含める**（既存 Application の Paths を更新）:
  - `/api/drivers/*`
  - `/api/driver-aliases/*`
  - `/api/driver-deductions/*`
  - `/api/dispatch-records/*`
  - `/api/excel-imports/*`
  - `/api/payment-summaries/*`
  - `/api/line-messages/*`
  - `/api/audit-logs/*`
  - `/api/reconciliations/*` ← Phase 2 新規
  - `/api/llm-parse/*` ← Phase 2 新規
- [ ] Identity Provider に組織のメールドメインを許可するポリシーを設定
- [ ] **LINE webhook (`/webhook`) は Access 対象外**（LINE 側から HMAC 認証付きで
      アクセスするため）。Paths にも含めないこと

---

## 5. デプロイ

### 5.1 ローカルで最終チェック

- [ ] 依存解決とビルド
  ```sh
  pnpm install
  pnpm -F worker typecheck
  pnpm -F web typecheck
  pnpm -F worker test
  ```
  → すべて成功すること

- [ ] (任意) ローカル wrangler dev で起動確認
  ```sh
  cd apps/worker
  cp .dev.vars.example .dev.vars  # 値を埋める
  pnpm dev
  ```

### 5.2 本番デプロイ

- [ ] Workers をデプロイ
  ```sh
  cd apps/worker
  pnpm build && wrangler deploy --env production
  ```
  > package.json の `deploy` スクリプトは default env 用なので、本番は明示的に
  > `--env production` を付ける。新しく `deploy:production` スクリプトを足す場合は
  > `"deploy:production": "vite build && wrangler deploy --env production"` を追加。

- [ ] デプロイ直後のリソースバインディングをログで確認
  ```sh
  wrangler tail --env production
  ```
  → 起動エラーやバインディング欠落が出ていないこと

---

## 6. 投入直後のスモークテスト

### 6.1 ヘルスチェック

- [ ] Webhook エンドポイントが 200 を返す（GET でも OK な実装）
  ```sh
  curl -i https://worker.example.com/webhook
  ```

- [ ] 認証なしの STEELO API は 401
  ```sh
  curl -i https://worker.example.com/api/drivers
  # → HTTP/2 401
  ```

- [ ] 認証付きで通る（API_KEY を Bearer で）
  ```sh
  curl -i https://worker.example.com/api/drivers \
    -H "Authorization: Bearer $API_KEY"
  # → HTTP/2 200, {"success":true,"data":[]}
  ```

### 6.2 LINE Webhook 接続確認

- [ ] LINE Developers Console で Webhook URL を `https://worker.example.com/webhook` に設定
- [ ] 「Verify」ボタンで Success が返る
- [ ] LINE グループに「テスト」と投稿 → D1 を確認
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --command "SELECT id, message_text, received_at FROM line_messages ORDER BY received_at DESC LIMIT 5"
  ```

### 6.3 Phase 2 LLM 解析の動作確認

- [ ] 配車メッセージ風のテキストを LINE グループに投稿
  ```
  田中太郎さん
  お疲れ様です。明日の案件詳細です。

  ①築地チャーター
  06:00 東京 集荷
  動態管理番号→BD-12345
  ```
- [ ] 5 分以内に `dispatch_records` が作成される
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --command "SELECT id, task_name, status, confidence FROM dispatch_records ORDER BY created_at DESC LIMIT 5"
  ```
- [ ] `llm_parse_results` に成功記録
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --command "SELECT status, token_input, token_output, cost_usd FROM llm_parse_results ORDER BY created_at DESC LIMIT 5"
  ```

### 6.4 受入チェックリスト

- [ ] [`phase1-acceptance.md`](./phase1-acceptance.md) の項目を一通り実施
- [ ] [`phase2-acceptance.md`](./phase2-acceptance.md) の項目を一通り実施

---

## 7. ロールバック手順

### 7.1 Worker ロールバック

- [ ] 直前のバージョンに戻す
  ```sh
  wrangler rollback --env production
  ```
  → 対話で過去デプロイの ID を選択。

### 7.2 D1 マイグレーション ロールバック

D1 には自動ロールバック機能がないため、Phase 2 migration 047 を **意図的に巻き戻したい**
場合の手順:

- [ ] 旧 reconciliations / llm_parse_results / reconciliation_jobs テーブルを drop
  ```sh
  wrangler d1 execute line-crm --env production --remote --command "
    DROP TABLE IF EXISTS reconciliations;
    DROP TABLE IF EXISTS reconciliation_jobs;
    DROP TABLE IF EXISTS llm_parse_results;
  "
  ```
  > ⚠️ 既に reconciliations データが入っている場合は事前にエクスポート。

### 7.3 Phase 2 機能だけ無効化（コードはそのまま）

- [ ] `ANTHROPIC_API_KEY` シークレットを削除すれば LLM 解析は skip される
  ```sh
  wrangler secret delete ANTHROPIC_API_KEY --env production
  ```
- [ ] 既存の `dispatch_records` 手動入力フローと支払明細生成は継続稼働

---

## 8. 監視・運用

### 8.1 日次確認

- [ ] Cloudflare Dashboard → Workers → 該当 Worker → Metrics
  - リクエスト数、CPU 時間、エラー率
- [ ] Queues の DLQ 滞留が無いか
  ```sh
  wrangler queues consumer list llm-parse-dlq
  wrangler queues consumer list reconciliation-dlq
  ```
- [ ] LLM 解析統計を Web で確認（`/llm-stats` 画面）

### 8.2 月初の照合運用

- [ ] 前月分の元請け Excel を `/excel-imports` で取込
- [ ] バッチを `confirm` して `client_records` を確定
- [ ] `/reconciliations` で対象月を選択 → 「照合実行」
- [ ] 3 タブ（matched / client_only / dispatch_only）をレビュー
- [ ] 不一致を必要に応じて手動マッチ or ダミー dispatch 追加
- [ ] `/payment-summaries` で支払明細 xlsx を一括生成

### 8.3 障害対応

| 症状 | 原因候補 | 対処 |
|---|---|---|
| Webhook が 5xx | D1 過負荷 / Worker エラー | `wrangler tail` でログ確認 |
| `is_parsed=0` が滞留 | `ANTHROPIC_API_KEY` 失効 / Anthropic 障害 | Console で key 確認、Anthropic status 確認 |
| 照合ジョブが `queued` のまま | Queue consumer 停止 | `wrangler queues consumer add` で再設定 |
| `reconciliation_jobs` が `running` で固まる | Worker タイムアウト | Scheduled が 30 分後に自動 failed に倒す |
| 支払明細生成が遅い | R2 書込失敗 | R2 bucket の存在 + 権限確認 |

### 8.4 シークレットローテーション

- [ ] **`API_KEY`** ローテーション（6 ヶ月推奨）
  1. 新キー生成 → `wrangler secret put API_KEY --env production`
  2. Web 管理画面のキーを更新
  3. 古いキーで叩いて 401 になることを確認
- [ ] **`ANTHROPIC_API_KEY`** ローテーション（漏洩時のみ）
  1. Anthropic Console で旧 key を削除
  2. 新 key を `wrangler secret put` で投入
  3. 失敗中のジョブが `*/5 * * * *` cron で再試行される

---

## 8.5. Phase 3 デプロイ追加手順

Phase 1 + Phase 2 が本番投入済みの状態で、Phase 3 を追加で投入する場合の手順。

### 8.5.1 D1 マイグレーション

- [ ] Phase 3 schema を本番 D1 に適用
  ```sh
  wrangler d1 execute line-crm --env production --remote \
    --file=packages/db/migrations/048_phase3_intelligence.sql
  ```

### 8.5.2 Queues 作成 (REPORT_QUEUE + DLQ)

- [ ] Phase 3 PDF レポート用キューを作成
  ```sh
  wrangler queues create report-queue
  wrangler queues create report-dlq
  ```

### 8.5.3 R2 にフォントをアップロード

PDF に日本語を埋め込むため Noto Sans JP TTF が必要。

- [ ] Noto Sans JP Regular を入手
  ```sh
  # GitHub の noto-fonts リポジトリから (要 git clone or 個別 DL)
  # または https://fonts.google.com/noto/specimen/Noto+Sans+JP からダウンロード
  ```

- [ ] R2 にアップロード
  ```sh
  wrangler r2 object put steelo-files/fonts/NotoSansJP-Regular.ttf \
    --file=NotoSansJP-Regular.ttf --env production
  ```

- [ ] (任意) Bold もアップロードすると見出しが太字に
  ```sh
  wrangler r2 object put steelo-files/fonts/NotoSansJP-Bold.ttf \
    --file=NotoSansJP-Bold.ttf --env production
  ```

### 8.5.4 Cron triggers 更新

`wrangler.toml` の `[env.production.triggers].crons` が 4 つに増えていることを確認:

```toml
[env.production.triggers]
crons = ["*/5 * * * *", "0 */6 * * *", "*/1 * * * *", "0 0 1 * *"]
```

| Cron | 役割 |
|---|---|
| `*/5 * * * *` | Phase 1+2 既存 + Phase 3 report job recovery / fallback / LLM streak 検知 |
| `0 */6 * * *` | Phase 1 既存 (import_batch_previews TTL クリーンアップ) |
| `*/1 * * * *` | **Phase 3 新規**: notification-dispatcher |
| `0 0 1 * *` | **Phase 3 新規**: 月初 baseline recompute + monthly_reminder |

- [ ] `wrangler deploy --env production` 後に Dashboard で 4 cron trigger が
      表示されていることを確認

### 8.5.5 Cloudflare Access に Phase 3 API パス追加

既存 Application に以下 3 パスを追加 (既存 Phase 1+2 パスはそのまま):

- [ ] `/api/anomaly-baselines/*`
- [ ] `/api/notification-settings/*`
- [ ] `/api/reports/*`

### 8.5.6 LINE 通知設定

- [ ] 管理画面または curl で初期設定:
  ```sh
  # 1. LINE Bot の User ID / Group ID を取得 (Phase 1 の bot が webhook で受信した
  #    line_messages.sender_user_id 等から確認可能)
  # 2. PUT で登録
  curl -X PUT https://worker.example.com/api/notification-settings \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "lineTargetId": "U1234567890abcdef1234567890abcdef",
      "enabledEvents": ["reconciliation_completed", "monthly_reminder", "llm_parse_failed_streak"]
    }'
  ```

- [ ] 1 分以内に LINE 宛にテスト通知が届くことを確認 (PUT 時に自動で
      reconciliation_completed の dummy payload が enqueue される)

### 8.5.7 動作確認

- [ ] [`phase3-acceptance.md`](./phase3-acceptance.md) の項目を一通り実施

## 9. デプロイ完了の判定基準

以下がすべて満たされたら「Phase 1 + Phase 2 本番投入完了」と判定する:

- [ ] §6.1〜6.3 のスモークテストが全件 PASS
- [ ] §6.4 の acceptance checklist が全件 PASS
- [ ] 24 時間運用しても §8.3 の症状リストにあるエラーが発生しない
- [ ] 翌月の月初照合で 3 分類が想定どおりに分かれる
- [ ] LLM コストが想定範囲内 (¥240〜500 / 月)

---

_最終更新: Phase 3 リリース時点。Phase 4 (機械学習スコア改善 / マルチテナント /
P2 payment_summary 再評価) を追加する時はこのドキュメントを更新すること。_
