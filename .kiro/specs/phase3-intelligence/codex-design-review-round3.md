## サマリー

第 3 回レビューの結論は **🟡 条件付き通過** です。Round 2 の 8 件は大半が反映され、**新規 CRITICAL は見つかりません**でしたが、実装 gate を完全に 🟢 にするには **F10 download 図の presigned URL 残存** と **notification payload schema の cross-spec 不整合** を先に消すべきです。

---

## Phase A 検証結果

| # | Round 2 指摘 | 検証結果 | 補足 |
|---|---|---|---|
| 1 | Slack 分離境界が design 図で再発 | ✅ 反映済み | Architecture は `ReconJob -> notification_deliveries -> slack-dispatcher/slack-notifier` に修正済み。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:63) F8 sequence も Slack 直呼びではなく delivery enqueue。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:188) |
| 2 | `notification_deliveries` の送信重複防止 | ✅ design / migration / tasks は反映済み | `status='processing'`, `claimed_at`, `claimed_by`, pending claim, stale recovery, `RETURNING` 前提が tasks まで揃う。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:490) [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:137) ただし requirements の Data Model 要約は古い status/payload 表現が残る。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:324) |
| 3 | `time_inversion` 720 分境界の矛盾 | ✅ 反映済み | `<=720 = overnight`, `>720 = inversion` に固定。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:108) |
| 4 | `anomaly_baselines` lifecycle | ✅ 反映済み | 対象 period の直前 3 完了月、DELETE → INSERT の全置換、D1 batch transaction が明記。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:49) D1 `batch()` は公式 docs 上も SQL transaction として扱われ、失敗時は sequence を rollback する説明です。([developers.cloudflare.com](https://developers.cloudflare.com/d1/worker-api/d1-database/)) |
| 5 | `report_jobs.source_*_id` 必須条件 | ✅ 反映済み | report type ごとの source 必須条件、source 不在時 422、DB query 層の `createJob` で判定する task が明記。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:245) [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:243) |
| 6 | cron 別の処理分岐 | ✅ 反映済み | `event.cron` switch、`wrangler.toml` trigger 追加、`report-queue` consumer routing が design + tasks に揃う。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:137) [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:50) |
| 7 | payload schema バージョニング | ⚠️ 部分反映 | design SQL と tasks は `event_payload_json` + `payload_schema_ver` + 送信時 Block Kit 組立に直る。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:490) [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:155) ただし requirements Data Model と F9 sequence に旧 `payload_json` 表現が残る。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:334) [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:220) |
| 8 | `dispatch_overload` precompute 対象 | ✅ 反映済み | `getDispatchesForPeriod(period)` の period 内 dispatch 全件に固定。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:124) 現行取得関数も period dispatch 全件を返す。[reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:526) |

---

## Phase B 検証結果

| # | Round 1 partial | Round 2 補強 | 補足 |
|---|---|---|---|
| 4 | Slack retry 累積時間 | ✅ 反映済み | 各 fetch 5 秒 timeout と最大 27 秒が requirements/tasks に明記。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:162) [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:155) |
| 5 | `reconciliation-job` から Slack 直接呼び出し禁止 | ✅ 反映済み | Architecture、F8、F9 text と tasks が enqueue 境界に揃う。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:119) |
| 10 | `dispatch_overload` 判定入力 | ✅ 反映済み | precompute 対象集合まで固定済み。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:124) |
| 11 | `time_inversion` 720 境界 | ✅ 反映済み | 境界例まで明記済み。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:108) |
| 13 | Slack 通知重複防止 | ✅ 反映済み | enqueue idempotency に加えて claim / stale recovery まで追加。[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:137) |
| 14 | PDF download 方式 | ❌ 未完 | requirements / security / tasks は authenticated proxy download だが、F10 sequence に `createPresignedUrl` が残る。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:265) |
| 19 | PDF source identity | ✅ 反映済み | report type ごとの source 必須 + source 不在 422 が spec 化。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:245) |

---

## Phase C 新規指摘

- **[HIGH] `notification_deliveries` の payload schema が requirements と design 内で二重定義になっている**:  
  [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:324) Requirement 8.1、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:220) F9 sequence、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:490) migration SQL。  
  問題: migration SQL と tasks は `event_payload_json` + `payload_schema_ver` だが、requirements の Data Model 要約は旧 `payload_json (Slack Block Kit)`、F9 sequence も `payload_json` のまま。  
  影響: 実装者が「delivery row に Block Kit を保存する」旧案と「event payload を保存して送信時 render」新案のどちらでも実装できてしまい、Round 2 #7 を再発させる。  
  推奨対応: requirements Data Model、F9 sequence、`slack-notifier.ts` interface 説明を `event_payload_json` 起点に統一する。

- **[MEDIUM] Slack 通知遅延の Goal が cron 設計と一致していない**:  
  [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:18) Goals、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:261) F9 note。  
  問題: Goal は「照合完了 → 投稿 ≤ 5 秒」だが、同じ design は `*/1` cron なので最大 1 分遅延を許容している。  
  影響: 実装・テスト・受入で成功基準が割れる。  
  推奨対応: Phase 3 Goal を「最大 1 分」へ直すか、5 秒を維持するなら cron ではなく queue 方式へ戻す。

---

## Phase D 実装着手前の最終確認

### 1. 実装者が判断保留できる余地

まだあります。

- F10 download は本文と図が矛盾しているため、proxy と presigned URL の別解が残る。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:265)
- notification payload は requirements と design SQL が一致しておらず、保存形式の別解が残る。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:334) [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:494)

### 2. `migration 048` 確認

物理ファイル `packages/db/migrations/048_phase3_intelligence.sql` は現時点の repo にはまだ存在しません。実装前 spec として見るなら、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:450) の inline migration SQL には Round 2 の主要変更が入っています。

- `notification_deliveries.status='processing'`
- `claimed_at`
- `claimed_by`
- `payload_schema_ver`
- `event_payload_json`
- `report_jobs.source_*_id`
- `active_report_key`

ただし requirements 側の Data Model 要約は migration SQL と同期が取れていません。

### 3. Cloudflare cron trigger 上限

現行 repo の `wrangler.toml` は 2 trigger です。[wrangler.toml](/home/user/steelo-invoice/apps/worker/wrangler.toml:89) Phase 3 design は `*/1` と `0 0 1 * *` を足して 4 trigger にします。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:163)

2026 年 5 月 21 日時点で確認した Cloudflare 公式 Limits 表は cron trigger 数を **per account** で Free 5 / Paid 250 と示しており、少なくともその表からは「1 Worker / environment 3 個上限」は確認できません。Free account で他 Worker の cron を使っていなければ 4 個は表上収まりますが、deploy 前に実アカウントの残枠確認は必要です。

### 4. D1 claim / batch 前提

- `claimBatch()` の `UPDATE ... RETURNING` は tasks に明記済み。[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:137)
- D1 docs は SQLite 互換を掲げていますが、今回確認した公式ページ上で `UPDATE ... RETURNING` を個別に明示した説明までは見つかりませんでした。ユーザー指定どおり「D1 は対応前提」で gate を止める必要はありませんが、Task 3.2 の integration test で local D1 と実 D1 の claim path を早めに踏むべきです。
- baseline DELETE → INSERT 全置換は D1 batch transaction の使い方として spec は妥当です。公式 docs 上、batch 内の各 statement は順次実行され、失敗時は sequence rollback と説明されています。([developers.cloudflare.com](https://developers.cloudflare.com/d1/worker-api/d1-database/))

### 5. Phase 1+2 既存実装との衝突

- 現行 [reconciliation-job.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation-job.ts:20) は `env` と payload だけで動き、Slack を差し込む余地を spec 側で enqueue に閉じたのは正しいです。
- 現行 [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:809) は全 cron 共通処理が多く、Phase 3 の `event.cron switch` 明記は必要です。spec は「追加だけ」ではなく、責務ごとに branch を限定する方向を示せています。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:137)
- 現行 queue consumer は `payment-job-queue` / `llm-parse-queue` / `reconciliation-queue` 固定です。[index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:996) `report-queue` 分岐追加は design/tasks と一致しています。
- `event_payload_json` 方式は Slack 固有 Block Kit を delivery row に固定しないため、Phase 4 の Email 等へ進む方向としては良いです。ただし requirements の旧 `payload_json (Slack Block Kit)` 表現を消さないとその利点が spec から弱くなります。

---

## 実装 gate 判定

## 🟡 条件付き通過

条件は次の 2 点です。

1. [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:265) の F10 sequence から presigned URL を消し、authenticated proxy download に統一する。  
2. [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:324) と [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:220) の notification payload 表現を `event_payload_json` + `payload_schema_ver` に統一する。

この 2 点を直せば、今回確認した範囲では **CRITICAL 0 で 🟢 通過** にできます。

---

## 次のタスクはこれ

1. F10 sequence の `createPresignedUrl` 線を proxy download に直す。  
2. requirements / F9 sequence / notifier interface の payload 表現を `event_payload_json` に統一する。  
3. `design.md` の Slack latency Goal を cron 実態に合わせて直す。  
4. その後 `spec.json` の `ready_for_implementation` 更新判断に進む。[spec.json](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/spec.json:1)

---

## 今の進捗を全体像から整理するとこれ

- Round 2 の 8 指摘: **7 件は実装判断に足る水準まで反映**
- Round 1 partial 7 件: **PDF download 図だけ未完**
- 新規 CRITICAL: **0**
- 新規 HIGH: **notification payload schema の cross-spec 不整合 1 件**
- 現在地: **実装直前。設計の大枠は通っているが、最後に図と schema 表現を揃える段階**