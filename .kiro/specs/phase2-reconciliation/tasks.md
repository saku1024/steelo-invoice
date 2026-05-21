# Implementation Plan — Phase 2 Reconciliation

`requirements.md`（7 要件）と `design.md` に基づく実装タスク。
Foundation → Core → Integration → Validation の順、`(P)` で並列実行可能を示す。

---

## 1. Foundation

- [ ] 1.1 D1 マイグレーション `047_phase2_reconciliation.sql` を作成し schema.sql に同期
  - `llm_parse_results`, `reconciliations`, `reconciliation_jobs` を追加
  - 各テーブルの UNIQUE / generated column を sqlite3 で動作確認
  - 観測可能完了条件: `pnpm db:migrate:local` で全テーブルが作成され、
    重複 message_id INSERT が UNIQUE 違反で弾かれることをテストで確認
  - _Requirements: 7.1_

- [ ] 1.2 Cloudflare バインディングを wrangler.toml に追加
  - Queues `llm-parse-queue` と `reconciliation-queue` を producer/consumer 両方
  - `wrangler secret put ANTHROPIC_API_KEY` の運用手順を README に追記
  - 観測可能完了条件: `wrangler dev` でキューバインディングが警告なくロードされる
  - _Requirements: 1.1, 6.2_

- [ ] 1.3 共有型を `@line-crm/shared` に追加
  - `LLMParseResult`, `Reconciliation`, `ReconciliationJob`, `MatchStatus`,
    `MatchMethod`, `LLMDispatchRecord` を camelCase で定義
  - `AuditAction` に `llm_parse_request` / `reconciliation_run` /
    `reconciliation_review` / `dispatch_manual_match` を追加
  - 観測可能完了条件: worker / web 双方から型インポートできて typecheck パス
  - _Requirements: 6.5, 7.2_

- [ ] 1.4 Anthropic SDK 導入 + `services/llm-client.ts` 雛形
  - `@anthropic-ai/sdk` を apps/worker に追加
  - `services/llm-client.ts` に `parseDispatchMessage(client, req, version)` を実装
  - prompt caching を有効化、token usage を返す
  - 観測可能完了条件: モック Anthropic でユニットテスト 3 ケース（正常 / リトライ / 失敗）
  - _Requirements: 1.7, 5.4, 6.4_

---

## 2. LLM プロンプト管理（F2 基盤）

- [ ] 2.1 `services/llm-prompts.ts` を実装
  - `version: 1` から開始、system prompt + JSON output schema を定数化
  - 配車メッセージ判定ロジックを自然言語で記述、出力例を埋め込む
  - 観測可能完了条件: ユニットテストでバージョン番号とプロンプトが固定値を返す
  - _Requirements: 5.3_

- [ ] 2.2 `services/llm-parser.ts` を実装
  - `line_messages` から 1 件取り出し、短文 / 非テキストならスキップ
  - llm-client + プロンプトで Claude Haiku 呼び出し、結果を `llm_parse_results` に保存
  - `dispatch_records` を `status='auto'|'needs_review'` で作成
  - リトライ + backoff
  - 観測可能完了条件: モック client でユニットテスト 6 ケース
    （正常 / 非配車 / 短文 / リトライ成功 / 4 回失敗 / 既存 parse 結果あり）
  - _Requirements: 1.1-1.9_

---

## 3. LLM Queue / Consumer 統合

- [ ] 3.1 webhook.ts に enqueue 経路を追加
  - `handleGroupMessage` で line_messages INSERT 後、`LLM_PARSE_QUEUE.send({ messageId, lineMessageId })` を呼び出す
  - Queues 未バインド時は Scheduled fallback でも動く
  - 観測可能完了条件: 統合テストで webhook → enqueue → DB の流れが動作
  - _Requirements: 1.1_

- [ ] 3.2 index.ts に queue consumer 登録
  - `llm-parse-queue` メッセージを `llm-parser.ts` に渡す
  - 既存の `payment-job-queue` consumer と共存
  - 観測可能完了条件: wrangler dev で複数 queue が同時にバインディングされる
  - _Requirements: 1.1, 6.1_

- [ ] 3.3 scheduled fallback で `is_parsed=0` を拾う処理を追加
  - `*/5 * * * *` で `line_messages.is_parsed=0` を最大 50 件取り出し再 enqueue
  - Queues 未利用環境でも本番運用できるようにする
  - 観測可能完了条件: cron テストで未解析メッセージが消化される
  - _Requirements: 1.1, 1.6_

---

## 4. 照合エンジン（F4）

- [ ] 4.1 (P) `services/reconciliation.ts` を純粋関数として実装
  - strong / fuzzy / time / none の判定ロジック
  - Levenshtein 距離は自前実装で済ませる（依存追加なし）
  - 観測可能完了条件: 8 ケース以上のユニットテスト
    （正常一致 / カナ違い / 時刻一致 / 完全不一致 / 複数候補 / null safety 等）
  - _Boundary: services/reconciliation.ts_
  - _Requirements: 2.1-2.7_

- [ ] 4.2 `db/reconciliations.ts` クエリ関数
  - `upsertReconciliations(jobId, period, rows[])` をバッチで実行
  - 旧 reconciliations を `archived` に倒すヘルパ
  - 観測可能完了条件: 7 ケース以上の DB ユニットテスト
  - _Boundary: packages/db (reconciliations)_
  - _Requirements: 2.3, 2.4_

- [ ] 4.3 `db/reconciliation-jobs.ts` クエリ関数
  - createJob (active_period_key UNIQUE で 409)、tryMarkRunning、progress 更新、completed/failed 切替
  - 観測可能完了条件: 4 ケースのユニットテスト
  - _Boundary: packages/db (reconciliation-jobs)_
  - _Requirements: 3.7, 6.2_

- [ ] 4.4 `services/reconciliation-job.ts` の consumer
  - dispatch / client を全件取得し reconcile() を実行
  - 結果を upsertReconciliations、status='completed' に
  - エラー時は markFailed
  - 観測可能完了条件: 1 ヶ月分の dispatch + client モックデータで 60s 以内に完了
  - _Requirements: 2.6, 6.2_

---

## 5. ルート / API

- [ ] 5.1 `routes/reconciliations.ts`
  - POST /api/reconciliations/jobs { period }: ジョブ投入
  - GET /api/reconciliations/jobs/:id: 状態取得
  - GET /api/reconciliations?period&status&driverId&page: 照合結果取得（3 タブ用）
  - POST /api/reconciliations/:id/review { reviewed: true|false }
  - POST /api/reconciliations/:id/manual-match { dispatchId | clientRecordId }
  - 観測可能完了条件: 各エンドポイントの HTTP コード（200/202/400/404/409）の手動 curl テスト
  - _Requirements: 3.1-3.7_

- [ ] 5.2 (P) `routes/llm-parse.ts`
  - POST /api/llm-parse/messages/:id/reparse: 1 件再解析（運用ツール）
  - GET /api/llm-parse/stats?period: token usage / 成功率の集計
  - 観測可能完了条件: 各エンドポイント動作確認
  - _Requirements: 1.6, 5.4_

- [ ] 5.3 dispatch-records route 拡張
  - GET フィルタに `status` と `confidence` を追加
  - PATCH で `status='confirmed'` に更新するエンドポイント
  - 観測可能完了条件: フィルタクエリ動作確認
  - _Requirements: 4.1-4.4_

- [ ] 5.4 index.ts に新規ルートをマウント + STEELO CORS / Access 配下に
  - `/api/reconciliations/*`, `/api/llm-parse/*` を `STEELO_PATH_PREFIXES` に追加
  - 観測可能完了条件: 全ルートが 401（未認証）で応答、許可外 origin で 403
  - _Requirements: 6.1_

---

## 6. Web UI

- [ ] 6.1 `/reconciliations/page.tsx` 一覧画面
  - 月選択 + 「照合実行」ボタン（ポーリング進捗表示）
  - 3 タブ（matched / client_only / dispatch_only）、件数バッジ、フィルタ
  - 観測可能完了条件: Next.js ビルド成功、開発サーバで遷移可能
  - _Requirements: 3.1, 3.2, 3.7_

- [ ] 6.2 (P) `/reconciliations` の差分レビューモーダル
  - matched 行で dispatch と client を左右表示、フィールド差分ハイライト
  - 「確認済み」ボタンで reviewed=1 を更新
  - 観測可能完了条件: モーダルが開く / 確認済みで一覧反映
  - _Depends: 6.1_
  - _Requirements: 3.3, 3.4_

- [ ] 6.3 (P) 手動マッチング UI
  - dispatch_only に対して候補表示 + マッチ作成
  - client_only に対してダミー dispatch 追加フォーム
  - 観測可能完了条件: 各操作が反映されて 3 タブの件数が変化する
  - _Depends: 6.1_
  - _Requirements: 3.5, 3.6_

- [ ] 6.4 dispatch-records UI 拡張
  - status / confidence バッジとフィルタ追加
  - 元 LINE メッセージと LLM 出力 JSON を別パネル表示
  - 観測可能完了条件: UI で needs_review → confirmed 遷移ができる
  - _Requirements: 4.1-4.5_

- [ ] 6.5 sidebar.tsx に「照合結果」「LLM 統計」を追加
  - 既存「STEELO 運送」セクションに 2 項目追加
  - 観測可能完了条件: ナビから両画面に遷移できる
  - _Requirements: 3.1, 5.4_

- [ ] 6.6 lib/api.ts に `steelo.reconciliations` / `steelo.llmParse` を追加
  - 既存パターン踏襲、polling ヘルパは Phase 1 のを流用
  - 観測可能完了条件: web 側の typecheck パス
  - _Requirements: 3.1-3.6_

---

## 7. Validation

- [ ] 7.1 ゴールデンセットを準備し SLO テストを追加
  - `tests/fixtures/llm-golden.json` に 30 件のメッセージ + 正解
  - `pnpm -F worker exec vitest run src/services/llm-parser.golden.test.ts` で F1 / 一致率を計算
  - is_dispatch F1 ≥ 0.9, フィールド一致率 ≥ 0.85 で fail
  - 観測可能完了条件: ローカル + CI で golden test 通過
  - _Requirements: 5.1, 5.2_

- [ ] 7.2 統合テスト追加
  - LINE webhook → llm-parse-queue → dispatch_records 作成
  - reconcile job 投入 → 3 分類が DB に保存
  - 同 period の二重投入が 409
  - 観測可能完了条件: 既存 116 テスト + Phase 2 追加分が全件緑
  - _Requirements: 1.1, 2.1, 3.7_

- [ ] 7.3 CI bench/test ワークフロー更新
  - .github/workflows/steelo-bench.yml に Phase 2 のテストを追加
  - golden test も含める
  - 観測可能完了条件: PR で全テストが走る
  - _Requirements: 5.1, 6.3_

- [ ] 7.4 手動受入チェックリスト更新
  - docs/operations/phase2-acceptance.md を追加
  - LLM 解析 / 自動照合 / 手動マッチ / 監査ログ の手順を網羅
  - 観測可能完了条件: チェックリストがリポジトリに存在
  - _Requirements: 6.5_

---

## カバレッジ確認

- Requirement 1（LLM 解析、1.1-1.9）: tasks 1.4, 2.1-2.2, 3.1-3.3, 5.2
- Requirement 2（照合エンジン、2.1-2.7）: tasks 4.1-4.4, 5.1
- Requirement 3（照合結果画面、3.1-3.7）: tasks 5.1, 6.1-6.3, 6.6
- Requirement 4（dispatch UI 拡張、4.1-4.5）: tasks 5.3, 6.4
- Requirement 5（品質、5.1-5.4）: tasks 7.1, 5.2
- Requirement 6（非機能、6.1-6.5）: tasks 1.2-1.3, 3.2, 5.4, 7.3
- Requirement 7（データモデル、7.1-7.3）: tasks 1.1, 1.3, 4.2-4.3

全要件 ID が少なくとも 1 タスクに対応していることを確認済み。
