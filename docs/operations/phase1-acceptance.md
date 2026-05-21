# Phase 1 MVP 手動受入チェックリスト

Phase 1 MVP の本番投入前に、以下の手動シナリオで業務要件の充足を確認する。
コードレベルのテスト（ユニット・統合）と並行して必須で実施すること。

> **デプロイ手順そのもの** は [`deployment.md`](./deployment.md) を参照。
> 本ドキュメントは「動作確認シナリオ」を扱う。デプロイ後の §6 スモークテストから
> 続く位置付け。
>
> **Phase 2** の受入は [`phase2-acceptance.md`](./phase2-acceptance.md) へ。

## 0. 事前準備

- [ ] Cloudflare Access が STEELO 系の全ホスト／パスに有効化されている
      （`docs/operations/cloudflare-access.md` の手順）
- [ ] `STEELO_WEB_ORIGINS` シークレットが本番に設定済み
- [ ] R2 バケット `steelo-files` が作成済み、ライフサイクルルール（preview 24h / generated 13ヶ月）設定済み
- [ ] Queues `payment-job-queue` 作成済み（または Scheduled fallback 運用合意済み）
- [ ] D1 マイグレーション `046_steelo_phase1.sql` が適用済み
- [ ] ドライバーマスタ 20 名分が登録済み、`line_group_id` 紐付け済み
- [ ] 各ドライバーの `has_invoice` が業務側と一致

## 1. F1 LINE グループメッセージ受信

- [ ] 実 LINE グループに任意のテキストメッセージを送信
- [ ] 数秒以内に Worker のログ／監査ログ で受信を確認できる
- [ ] D1 `line_messages` テーブルに 1 行が追加されている
- [ ] 同じグループから 2 通目を送信 → 2 行目が追加される
- [ ] **同一 message_id の Webhook を 2 回受信させる（手動再送）と
      `line_messages` に重複が増えないことを確認**（冪等性）
- [ ] 画像／ファイル送信時に `message_type` がそれぞれ image/file になり、
      `message_text` は NULL で保存される
- [ ] LINE 署名検証失敗（不正な signature ヘッダ）時に 200 を返しつつ
      DB には行が増えない
- [ ] LINE 公式の「3秒以内応答」を満たす（手動 curl 計測 or Cloudflare Analytics）

## 2. F3 元請け Excel インポート

- [ ] 実 BOND's の過去 Excel（2026-03 等 1〜2 ヶ月分）を管理画面からアップロード
- [ ] preview 画面に件数・サマリー（運賃合計／立替／控除）が正しく表示される
- [ ] 未紐付け DR 名がある場合、preview 画面で警告と一覧が表示される
- [ ] preview 画面の「別名追加」から `driver_aliases` を 1 件登録 →
      再 preview で未紐付け件数が減ることを確認
- [ ] 確定ボタン押下 → `import_batches.status='confirmed'` が 1 件作成され、
      `client_records` が件数分 INSERT される
- [ ] **同 period の Excel を再度アップロード → 409 と上書き確認モーダルが出る**
- [ ] 上書き選択 → 旧 batch が `archived` になり、新 batch が `confirmed` になる
- [ ] `audit_logs` に `import_confirm` / `import_overwrite` が記録される
- [ ] preview 後に 1 時間放置 → scheduled 実行で `import_previews` 行と
      R2 オブジェクトが削除される
- [ ] 不正ファイル: 数式入りの xlsx をアップロード → 422 FORMULA_NOT_ALLOWED
- [ ] サイズ超過: 10MB 超のファイルをアップロード → 413
- [ ] 行数超過: 6000 行の xlsx をアップロード → 422 TOO_MANY_ROWS

## 3. F5 管理画面操作

- [ ] ドライバーマスタ画面で CRUD（追加・編集・論理削除）が動く
- [ ] `line_group_id` 重複で 409 を返す
- [ ] driver_aliases 画面で別名 CRUD が動く（重複 alias_name で 409）
- [ ] driver_deductions 画面で月単位の控除を 20 名分 UPSERT できる
- [ ] LINE メッセージ閲覧画面でフィルタ（driver/期間/type）が動く
- [ ] 配車レコード手動 CRUD が動く
- [ ] **非ログイン状態で `/api/drivers` を curl すると 401 を返す**（既存 auth）
- [ ] **Cloudflare Access 未認証で管理画面にアクセスすると Access に redirect**
- [ ] CORS: 許可外 origin からの `/api/drivers` リクエストが 403

## 4. F6 支払明細生成

### 個別生成（同期 API）
- [ ] 任意の 1 ドライバー + 確定済み period で「個別 DL」を実行
- [ ] 同期 API が **2 秒以内**で xlsx を返す
- [ ] DL された xlsx を Excel で開いて、宛名・運賃合計・最終支払額が
      正しいことを確認（手計算 1〜2 行で検算）
- [ ] `driver_payment_summaries` にスナップショット行が UPSERT される
      （commission_rate_snapshot / tax_rate_snapshot / import_batch_id /
      driver_name_snapshot が埋まる）
- [ ] `payment_summary_lines` に明細行が記録される
- [ ] 同じドライバーで再生成 → スナップショットが上書きされ、
      `payment_summary_lines` も置き換わる（重複しない）
- [ ] R2 に xlsx が保存され、`r2_xlsx_key` が埋まる
- [ ] 再 DL: `GET /api/payment-summaries/:id/download` で同じ xlsx を取得できる
- [ ] R2 から手動でオブジェクトを削除 → 再 DL が 410 を返す

### 一括生成（非同期ジョブ）
- [ ] `POST /api/payment-summaries/jobs` で対象月を投入 → 202 を返す
- [ ] `payment_jobs.status` が queued → running → completed と推移する
- [ ] 同 period の二度目投入が 409（active_period_key UNIQUE）
- [ ] **20 名分の completed までを 5 分以内に到達**
- [ ] R2 に各ドライバー xlsx と all.zip が保存される
- [ ] `GET /api/payment-summaries/jobs/:id/download` で ZIP を取得できる
- [ ] ZIP を展開 → 20 名分の xlsx がファイル名 `{period}_{name}_支払明細.xlsx` で含まれている
- [ ] `audit_logs` に `payment_batch_generate` が記録される

### 計算検証
- [ ] インボイスあり ドライバー: 運賃 7,680 円 × 1 行 → 税込 7,814 円
      （= round(7680 × 0.925 × 1.1)）
- [ ] インボイスなし ドライバー: 運賃 7,680 円 × 1 行 → 7,104 円
- [ ] 同便従属行（運賃 `-`）は明細掲載されるが totals から除外される
- [ ] driver_deductions で前払金を設定 → final_amount から減算される
- [ ] マイナス支払額のドライバー → xlsx に `▲` プレフィックス付きで表示
- [ ] 行単位四捨五入が適用される（合算後丸めと数円差が出るケースで確認）

## 5. 監査ログ

- [ ] 直近の `import_confirm` / `payment_generate` / `deduction_update` が
      `/audit-logs` 画面（または `/api/audit-logs`）で検索可能
- [ ] non-admin ロールでは `/api/audit-logs` が 403

## 6. ベンチマーク

- [ ] `pnpm -F worker test:bench` がローカルでパスする
- [ ] CI でも `test:bench` がパスしている（GitHub Actions ログ確認）
- [ ] 上限超過テストデータ（5000 行）で bench がフェイルすること
      （境界検出能力の確認）

## 7. クリーンアップとロールバック

- [ ] テスト用に作成した driver / batch / summaries / jobs の削除手順が確立済み
      （D1 admin 経由）
- [ ] R2 バケット内のテストオブジェクトの削除手順が確立済み
- [ ] 万一の本番障害時のロールバック手順
      （migration 046 を切り戻す、Access policy を無効化、Queues を停止）が
      `docs/operations/cloudflare-access.md` を参照しつつ整理されている

---

**チェックリスト完了の判定**:
- 0〜6 の全項目に [x] が入った時点で Phase 1 受入完了
- 7 の項目は本番投入条件ではないが、運用開始 1 週間以内に整備すること
