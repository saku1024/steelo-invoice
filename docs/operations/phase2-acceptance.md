# Phase 2 (Reconciliation) 手動受入チェックリスト

Phase 2 (F2 LLM 解析 + F4 自動照合) を本番投入する前の手動チェック。
Phase 1 のチェック (`docs/operations/phase1-acceptance.md`) を踏破済みの
前提で追加項目を行う。

## 0. 事前準備

- [ ] D1 migration `047_phase2_reconciliation.sql` が適用済み
      `wrangler d1 execute line-harness --remote --file=packages/db/migrations/047_phase2_reconciliation.sql`
- [ ] `ANTHROPIC_API_KEY` シークレットが本番に設定済み
      `wrangler secret put ANTHROPIC_API_KEY --env production`
- [ ] Queues `llm-parse-queue` と `reconciliation-queue` が作成済み
      `wrangler queues create llm-parse-queue`
      `wrangler queues create reconciliation-queue`
- [ ] Phase 1 と同じ Cloudflare Access Application 配下に新規パスが含まれている
      （`/api/reconciliations/*` `/api/llm-parse/*`）

## 1. F2: LLM 解析

- [ ] 実 LINE グループに配車らしいテキストメッセージを送信
- [ ] 5 分以内に `dispatch_records` が **status='auto'** で作成される
- [ ] `llm_parse_results` に `status='success'`、`output_json` 入り、
      `token_input` / `token_output` / `cost_usd` が記録されている
- [ ] LINE で「ありがとう」程度の短文を送信 → `is_parsed=1, is_dispatch=0`、
      LLM API は呼ばれない（コスト保護）
- [ ] 画像メッセージを送信 → 同上（スキップ）
- [ ] 配車ではないテキスト（「お疲れさま」等）→ `is_dispatch=0`、
      dispatch_records は作成されない
- [ ] `/api/llm-parse/messages/:id/reparse` で手動再解析が動く
- [ ] `/api/llm-parse/stats?from=...&to=...` で集計が取れる
- [ ] `/llm-stats` 画面で total / 成功率 / token / コストが表示される
- [ ] 月 1,000 件想定で **月コスト ¥500-1,500** に収まる
      （`stats.cost_usd_sum` × 150 ≒ JPY）

## 2. F4: 自動照合エンジン

- [ ] Phase 1 で取り込み済みの `client_records` と LINE 由来の `dispatch_records`
      がある対象月で `/reconciliations` 画面を開く
- [ ] 「照合実行」ボタン → ジョブ投入 → ポーリングで完了表示
- [ ] **20-50 件規模で 60 秒以内に完了** する
- [ ] 3 タブの件数バッジ（matched / client_only / dispatch_only）が正しい
- [ ] `matched` 行で `match_method=strong` / `score=1.0` が表示される
- [ ] カナ違い / 1-2 字違いで `match_method=fuzzy` / `score=0.7` が表示される
- [ ] 時刻だけ近い違う業務名で `match_method=time` / `score=0.5` が表示される
- [ ] 「確認済み」ボタン → `reviewed=1, reviewed_at, reviewed_by` が更新
- [ ] 「確認済み」状態で再度照合実行 → 旧結果は `archived_reviewed` に保持される
- [ ] 未確認の旧結果は `archived` になり、新結果が `active` で表示される
- [ ] 同 period の二重投入が 409 で拒否される（active_period_key UNIQUE）

## 3. 異常検出 (warnings)

- [ ] 同 driver の運賃中央値から 50% 以上乖離した client_record で
      `warnings: ["fare_deviation: fare=...", ...]` が記録される
- [ ] 立替金あり client_record にマッチする dispatch が無い場合に
      `advance_payment_without_dispatch` warning が出る
- [ ] driver_id 未紐付け client_record は `client_only` として記録される

## 4. dispatch_records UI 拡張

- [ ] `/dispatch-records` で `status='auto'` と `'needs_review'` バッジが表示
- [ ] `needs_review` 行を編集 → `status='confirmed'`、`confidence='high'`
- [ ] `auto` 行を確認ボタン → `status='confirmed'`、`confidence` は維持
- [ ] 元 LINE メッセージへのリンクから本文 + LLM 出力 JSON が確認できる

## 5. 監査ログ

- [ ] `/audit-logs` で以下のアクションが記録されている:
  - `llm_parse_request`（LLM 解析実行ごと、token usage 入り）
  - `llm_parse_reparse`（手動再解析）
  - `reconciliation_run`（照合実行）
  - `reconciliation_review`（確認済み切替）
  - `dispatch_manual_match`（手動マッチング）

## 6. パフォーマンス・コスト

- [ ] LLM 呼出 1 件あたり 2-5 秒以内
- [ ] 月次照合 1,000 件規模で 60 秒以内
- [ ] LLM 月コストが想定範囲内（prompt caching が効いていれば 50% 減）
- [ ] Webhook 応答は引き続き 3 秒以内（200 を即返却、保存は async）

## 7. 障害復旧

- [ ] LLM API 失敗時に `llm_parse_results.status='failed'` で記録され、
      Scheduled fallback で再解析される
- [ ] reconciliation_jobs が 30 分以上 running なら自動的に failed に倒される
- [ ] failed → 同 period の再投入が可能

## 8. ゴールデンセット (品質保証)

- [ ] `tests/fixtures/llm-golden.json` に 30 件以上の正解データがある
      （※ Phase 2 初版では未整備、Phase 2.1 で追加予定）
- [ ] CI で is_dispatch F1 ≥ 0.9、フィールド一致率 ≥ 0.85 を満たす

---

**次フェーズ予定（Phase 3 / 異常検知強化）**:
- 金額異常の閾値学習（過去 3 ヶ月の中央値ベース）
- 時刻矛盾検出（pickup → delivery が論理的でない）
- 月次レポート自動生成（PDF / Slack 通知）
