## サマリー

**実装 gate は未通過です。** 第 1 回指摘はかなり反映されていますが、**CRITICAL #5 の Slack 分離境界が設計図に再発**しており、さらに通知 dispatcher の claim 不在、baseline 再計算ライフサイクル、PDF source 固定の実効性に HIGH が残っています。

結論として、Phase 3 の方向性は進めてよいですが、**この spec のまま実装開始すると実装者が別解を作る箇所がまだ残る**ため、先に spec をもう 1 回締めるべきです。

---

## 第 1 回指摘の反映状況

| # | 第1回指摘 | 反映状況 | 補足 |
|---|---|---|---|
| 1 | fare deviation 判定式の単位不整合 | ✅ 完全反映 | z-score 判定に固定。`sd_fare == 0` の skip も明記。 |
| 2 | `warnings` 後方互換が optional migration 依存 | ✅ 完全反映 | `parseWarnings()`、API 常時 `StructuredWarning[]`、optional migration の位置づけが明確。 |
| 3 | PDF 日本語フォントに `fontkit` が必要 | ✅ 完全反映 | requirements / design / tasks に `@pdf-lib/fontkit` と `registerFontkit()` が入った。 |
| 4 | Slack retry と `waitUntil` 制限衝突 | ⚠️ 部分反映 | sleep 合計は `1s + 3s + 8s = 12s` に修正。ただし **各 fetch の timeout 上限**が spec 化されておらず、総時間が 30 秒以内とはまだ言い切れない。 |
| 5 | `reconciliation-job` から Slack 直接呼び出し禁止 | ⚠️ 部分反映 | requirements / F9 text / tasks は分離済みだが、architecture と F8 sequence に直接呼び出しが残る。 |
| 6 | `report_jobs` 排他・復旧が Phase 2 と不整合 | ✅ 完全反映 | `active_report_key`、enqueue fail、stuck recovery が Phase 2 パターンに寄った。 |
| 7 | report job を reconciliation queue に流用 | ✅ 完全反映 | `REPORT_QUEUE` 別建てに固定。 |
| 8 | `anomaly_baselines` の `NULL` unique 問題 | ✅ 完全反映 | partial unique index が明記された。 |
| 9 | baseline fallback 境界不足 | ✅ 完全反映 | task baseline / driver fallback / skip の優先順位が明確。 |
| 10 | `dispatch_overload` が detector interface で判定不可 | ⚠️ 部分反映 | `dispatchCountByDriverDate` precompute で純粋関数化は成功。ただし **何を count 対象にするか**がまだ曖昧。 |
| 11 | `time_inversion` の 12 時間境界曖昧 | ❌ 反映不十分 | requirements 内で `overnight distance < 720` と「720 は overnight 側」が矛盾。 |
| 12 | Phase 3 API の STEELO CORS prefix 抜け | ✅ 完全反映 | Foundation task 1.4 に prefix と test が追加。 |
| 13 | Slack 通知の重複防止なし | ⚠️ 部分反映 | enqueue idempotency は追加。ただし dispatcher の同 row 二重送信防止 claim が未定義。 |
| 14 | PDF download が Phase 1 方針とズレ | ⚠️ 部分反映 | requirements / security / tasks は proxy download。だが F10 sequence に presigned URL が残る。 |
| 15 | Slack webhook secret 保存方針が曖昧 | ✅ 完全反映 | Phase 3 は D1 平文 + mask + redaction と決定。 |
| 16 | `advance_payment_without_dispatch` の意味変更 | ✅ 完全反映 | Phase 2 warning 維持 + Phase 3 warning 追加と明記。 |
| 17 | PDF 性能・サイズ要件が曖昧 | ✅ 完全反映 | benchmark fixture、500 行超 fail、5MB は warn に整理。 |
| 18 | PDF test が snapshot 寄り | ✅ 完全反映 | 構造検証中心へ変更。 |
| 19 | PDF の source identity 未固定 | ⚠️ 部分反映 | `source_*_id` は追加されたが、nullable 挙動と既存データ上書き時の実効性が不足。 |
| 20 | F10 3 テンプレート同時実装のリスク | ✅ 完全反映 | P0 → P1 → P2 に分割。 |

---

## 新規指摘

### 1. **[CRITICAL] Slack 分離境界が design 図で再発している**

- 該当ファイル:
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:95) Architecture
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:149) F8 sequence
  - [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:275) Requirement 7.3
- 問題:
  - normative text は「`reconciliation-job` は `notification_deliveries` へ永続化のみ」。
  - しかし Architecture に `ReconJob --> Slackv`、F8 sequence に `Job->>Slack: notifyCompleted(...)` が残る。
- 影響:
  - 第 1 回 CRITICAL #5 の事故経路が設計図から再導入される。
  - 実装者が図を信じると queue consumer の job 本体に Slack 呼び出しを戻し得る。
- 推奨対応:
  - Architecture を `ReconJob -> notification_deliveries -> slack-dispatcher -> slack-notifier` に修正。
  - F8 sequence の直接 Slack 呼び出しを通知 enqueue に置換。
  - 「Slack notifier を呼べるのは dispatcher と test route のみ」と責務境界を明記。

---

### 2. **[HIGH] `notification_deliveries` は enqueue 重複は防ぐが、送信重複は防げていない**

- 該当ファイル:
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:176) F9 dispatcher flow
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:428) `notification_deliveries`
  - [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:129) Task 3.2-3.4
- 問題:
  - dispatcher は `SELECT pending LIMIT 10` で拾うだけ。
  - 複数 cron invocation が重なると同じ row を同時に送れる。
  - `idempotency_key UNIQUE` は delivery row の重複生成を止めるだけで、**Slack POST の二重実行**は止めない。
  - `next_retry_at` は nullable なのに task は `next_retry_at <= now` と書いており、実装次第では初回 pending が拾われない。
- 影響:
  - 同じ照合完了通知や月初 reminder が Slack に複数投稿される。
  - pending backlog が詰まる、初回送信されない、retry が競合する。
- 推奨対応:
  - claim 状態を追加する。
    - 例: `status='processing'`, `claimed_at`, `claimed_by`
    - `UPDATE ... WHERE status='pending' ... RETURNING` 相当の claim 手順を spec 化
  - `next_retry_at IS NULL OR next_retry_at <= now` を明記。
  - stale processing recovery も追加。
  - LLM cooldown は hour bucket key だけでは 24h を保証しないので、`cooldown_until` または「直近 24h の同 event sent/pending を query して skip」を明記。

---

### 3. **[HIGH] `time_inversion` の 720 分境界が requirements 内で矛盾している**

- 該当ファイル:
  - [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:96) Requirement 2.1
- 問題:
  - step 3 は overnight を `< 720`。
  - step 4 は `>= 720` を warning。
  - 直後の bullet は「720 は overnight 側」。
- 影響:
  - `12:00 -> 00:00` 相当の境界で実装が割れる。
- 推奨対応:
  - どちらかに固定。
  - 現在の意図を読む限り、overnight 側に含めるなら:
    - overnight: `overnightDistance <= 720`
    - inversion: `overnightDistance > 720`

---

### 4. **[HIGH] `anomaly_baselines` の「過去 3 ヶ月」と recompute ライフサイクルが未定義**

- 該当ファイル:
  - [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:49) Requirement 1.1
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:391) `anomaly_baselines`
  - [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:74) Task 2.2-2.3
- 問題:
  - `period_from` / `period_to` はあるが意味が固定されていない。
  - `recompute?period=YYYY-MM` の `period` が「対象照合月」なのか「計算終了月」なのか不明。
  - unique index は driver/task だけなので baseline は実質 1 世代。再計算時に消える driver/task と増える driver/task の扱いが未定義。
  - task 2.3 に `clearBaselines()` はあるが、削除と upsert の原子境界が spec 化されていない。
- 影響:
  - 旧 baseline が残留し、存在しないはずの driver baseline で anomaly 判定する。
  - 手動 recompute と cron recompute で対象月がズレる。
- 推奨対応:
  - 例として次に固定:
    - `period=2026-05` の baseline は `2026-02`〜`2026-04` の **完了月 3 ヶ月**
    - `period_from='2026-02'`, `period_to='2026-04'`
  - recompute は staging table または transaction 相当の「対象世代全置換」にする。
  - 古い行を delete するのか archive するのかを決める。

---

### 5. **[HIGH] `report_jobs.source_*_id` は追加されたが、PDF の source 固定がまだ成立していない**

- 該当ファイル:
  - [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:223) Requirement 5.5
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:443) `report_jobs`
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:224) report data fetch
  - [payment-summaries.ts](/home/user/steelo-invoice/packages/db/src/payment-summaries.ts:78)
- 問題:
  - `source_*_id` は nullable で、種別ごとの必須条件と NULL 時挙動がない。
  - design は「必要データ取得」としか書かず、source ID で読むのか `period` の最新状態で読むのか未固定。
  - Phase 1 import overwrite は旧 confirmed batch を archived にするため、`confirmed` query を使うと固定した import batch と別データを読む余地がある。[import-batches.ts](/home/user/steelo-invoice/packages/db/src/import-batches.ts:304)
  - P2 はさらに危険で、既存 `driver_payment_summaries` は同 driver × period を upsert し、既存 summary と lines を上書きする。[payment-summaries.ts](/home/user/steelo-invoice/packages/db/src/payment-summaries.ts:89)
- 影響:
  - PDF が「ジョブ開始時点の source」を報告する保証が弱い。
  - source ID が残っていても中身が変わる、または NULL で意味不明な PDF job ができる。
- 推奨対応:
  - report type ごとの必須 source を固定。
    - `reconciliation`: `source_reconciliation_job_id` 必須
    - `client_summary`: `source_import_batch_id` 必須
    - `payment_summary`: immutable snapshot source が必要
  - source が無ければ job 作成時点で 409/422 など明示 fail。
  - P2 は `payment_job_id` だけで足りるか再検討。既存 upsert 構造では immutable source として弱い。

---

### 6. **[HIGH] `*/1` cron 追加で既存 scheduled 処理の実行頻度が変わる**

- 該当ファイル:
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:124) cron design
  - [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:143) slack dispatcher
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:809)
  - [wrangler.toml](/home/user/steelo-invoice/apps/worker/wrangler.toml:89)
- 問題:
  - 現行 `scheduled()` は active cron trigger ごとに共通処理をかなり実行する。
  - `*/1` を増やすと、Slack dispatcher だけでなく既存 reminder / recovery / fallback scan も毎分走る可能性がある。
  - tasks は `REPORT_QUEUE` の default + production 追加は書いているが、`*/1` trigger と `0 0 1 * *` trigger の wrangler 追加、および `report-queue` の queue routing 更新が明示不足。
- 影響:
  - Phase 1/2 の cron 負荷と実行頻度が意図せず変わる。
  - `REPORT_QUEUE` を設定しても [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:996) の queue 分岐を更新しなければ unknown queue になる。
- 推奨対応:
  - `event.cron` ごとの処理範囲を spec 化。
  - Slack dispatcher は `*/1` branch に限定。
  - 月初 reminder は `0 0 1 * *` branch に限定。
  - tasks に wrangler trigger 追加と queue routing 追加を明記。

---

### 7. **[MEDIUM] raw Block Kit を `payload_json` に保存する設計は再送互換が弱い**

- 該当ファイル:
  - [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:428) `notification_deliveries`
- 問題:
  - payload が Slack Block Kit 構造そのもの。
  - payload 生成時点と再送時点で renderer や Slack 制約が変わると古い JSON を送り続ける。
- 影響:
  - retry / recovery が古い payload で失敗し続ける。
- 推奨対応:
  - `event_payload_json` と `message_version` を保存し、送信時に Block Kit を組み立てる。
  - 少なくとも payload schema version を持つ。

---

### 8. **[MEDIUM] `dispatch_overload` の precompute 対象集合がまだ曖昧**

- 該当ファイル:
  - [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:112)
  - [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:91)
- 問題:
  - `dispatchCountByDriverDate` を作ることは決まったが、count 対象が明記されていない。
  - 現行 job は period の dispatch 全件を取得する。[reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:526)
- 影響:
  - 実装者によって「照合候補全件」「matched rows のみ」「dispatch_only 含む全件」が分かれる。
- 推奨対応:
  - `getDispatchesForPeriod()` で取得した period 内 dispatch 全件を count する、など source を固定。

---

## 実装 gate 判定

## 🔴 未通過

理由:

1. 第 1 回 **CRITICAL #5** の禁止境界が design 図でまだ矛盾している。  
2. 通知 dispatcher の claim 不在により、idempotency の中心要件が送信段で未完。  
3. baseline recompute と PDF source 固定に、実装者判断へ逃げる重要仕様が残る。  

---

## 既存 Phase 1/2 との衝突確認

- `audit_logs.action` は DB 上は `TEXT` で ENUM 制約なし。[046_steelo_phase1.sql](/home/user/steelo-invoice/packages/db/migrations/046_steelo_phase1.sql:250)  
  型側は `AuditAction` union なので Task 1.2 の型追加は必要。
- `REPORT_QUEUE` は tasks で `wrangler.toml` の default + production 追加が明記されている。既存構成も default / production が分かれている。[wrangler.toml](/home/user/steelo-invoice/apps/worker/wrangler.toml:72)
- Web `/reconciliations` は現状 `warnings.join(', ')` 前提。[page.tsx](/home/user/steelo-invoice/apps/web/src/app/reconciliations/page.tsx:216)  
  Task 2.6 で UI 変更が入るので、ここは spec 上は対応対象に入っている。
- Phase 2 の `cache_control` silent no-op marker は LLM prompt 側の注意書きで、Phase 3 の failure streak と直接矛盾は見つからない。[llm-prompts.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-prompts.ts:31)

---

## 次のタスクはこれ

1. `design.md` の Slack 図を直し、`reconciliation-job` から Slack 直結線を完全に消す。  
2. `notification_deliveries` に claim / stale recovery / `next_retry_at NULL` 仕様を追加する。  
3. baseline の 3 ヶ月 window と recompute 全置換ルールを確定する。  
4. report type ごとの source 必須条件と P2 payment snapshot 方針を決める。  
5. その後に第 3 回レビューで **CRITICAL 0** を確認する。  

---

## 今の進捗を全体像から整理するとこれ

- Phase 1/2 の既存実装契約との照合: 完了  
- 第 1 回指摘 20 件の再判定: 完了  
- 第 2 回レビュー結果:
  - 完全反映: 12 件
  - 部分反映: 7 件
  - 反映不十分: 1 件
- 現在の状態:
  - Phase 3 の設計方向は成立
  - ただし Slack 境界、通知競合、baseline lifecycle、PDF source 固定がまだ設計 gate の残課題です。