## サマリー

Phase 3 は「異常検知 → 通知 → PDF レポート」の主要部品自体はかなり揃っていますが、**本番投入 gate としては未通過**です。特に `anomaly_baselines` の世代管理、cron 分岐、レポート download UI、PDF の source snapshot 整合に本番影響のある問題があります。

Phase 1 / Phase 2 の既存中核ロジックは今回見た範囲では過去レビュー反映後の形を保っています。ただし Phase 3 が `scheduled()` に入ったことで、Phase 1 / 2 の cron 責務まで巻き込む回帰が入っています。

---

# Phase 別評価

## Phase 1

過去レビューで固めた主要導線は、今回見た Phase 3 差分から直接壊されている形は見えていません。  
ただし `scheduled()` の Phase 3 追加により、Phase 1 の fallback / cleanup / delivery 系が **毎分 cron や月初 cron でも走る**構造になっており、ここは Phase 1 側にも影響します。

残課題:
- Phase 1 cron 責務が `event.cron` で完全に閉じていない。
- Phase 3 が同じ `LINE_CHANNEL_ACCESS_TOKEN` を push に使うため、Phase 1 の LINE channel 運用前提を明文化する必要がある。

---

## Phase 2

`reconciliations.warnings` の TEXT 列を維持しつつ、API read path で `parseWarnings()` を通して構造化 warning に揃える実装は整合しています。  
確認箇所は [routes/reconciliations.ts](/home/user/steelo-invoice/apps/worker/src/routes/reconciliations.ts:27)、[parse-warnings.ts](/home/user/steelo-invoice/apps/worker/src/services/parse-warnings.ts:47)、[phase2.ts](/home/user/steelo-invoice/packages/shared/src/phase2.ts:72) です。

残課題:
- Phase 3 の LLM 失敗 streak 判定が Phase 2 の `llm_parse_results` を使いますが、実装が「連続失敗」になっていません。
- `created_at` 文字列比較の形式差で 24h 判定が正確でない可能性があります。

---

# Phase 3

## 良い状態として確認できた点

- `anomaly-detector.ts` の z-score 境界、`sdFare <= 0` skip、overnight `<= 720` skip は spec と一致しています。  
  [anomaly-detector.ts](/home/user/steelo-invoice/apps/worker/src/services/anomaly-detector.ts:110)
- `dispatch_overload` は detector 内で DB を読まず、事前計算 `Map` を使って純粋関数性を保っています。  
  [anomaly-detector.ts](/home/user/steelo-invoice/apps/worker/src/services/anomaly-detector.ts:244)
- `parseWarnings()` は Phase 2 string array と Phase 3 structured array の read compatibility を持っています。  
  [parse-warnings.ts](/home/user/steelo-invoice/apps/worker/src/services/parse-warnings.ts:23)
- `notification_deliveries.claimBatch()` は単一 `UPDATE ... RETURNING` 文で claim しており、SQLite/D1 側の statement atomicity に寄せる実装です。  
  [notification-deliveries.ts](/home/user/steelo-invoice/packages/db/src/notification-deliveries.ts:110)
- `next_retry_at` / `claimed_at` / cooldown の比較は `toJstString()` に寄せており、同形式同士なら lexical order が時刻順になります。  
  [utils.ts](/home/user/steelo-invoice/packages/db/src/utils.ts:19)

---

## [CRITICAL]

### **[CRITICAL] baseline の世代管理が migration と実行設計で矛盾しており、翌月 recompute が壊れる**

- ファイル:
  - [048_phase3_intelligence.sql](/home/user/steelo-invoice/packages/db/migrations/048_phase3_intelligence.sql:30)
  - [anomaly-baselines.ts](/home/user/steelo-invoice/packages/db/src/anomaly-baselines.ts:38)
  - [reconciliation-job.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation-job.ts:57)
- 問題:
  - `replaceBaselinesAtomic()` は `period_from / period_to` が一致する旧世代だけ DELETE します。
  - しかし unique index は `(driver_id, task_name)` / `(driver_id)` だけで、`period_from / period_to` を含みません。
  - そのため `2026-02~04` の baseline が残った状態で翌月 `2026-03~05` を INSERT すると、同じ driver/task で UNIQUE 衝突します。
  - さらに read 側は `listAllBaselines()` で「現行世代」を選別しておらず、世代概念が DB / query / job で揃っていません。
- 影響:
  - 月初 baseline recompute が 2 回目以降失敗し、F8 の運賃異常検知が本番で止まります。
- 推奨対応:
  - どちらかに設計を固定してください。
  - 「常に現行 baseline だけ保持」なら recompute は全 baseline を置換する。
  - 「period window ごとに世代保持」なら unique index に period window を含め、照合時に対象 period 用 baseline だけ選ぶ。

---

# HIGH

### **[HIGH] `task_name = NULL` の task baseline と driver fallback が同じ unique slot を奪い合う**

- ファイル:
  - [anomaly-baseline-job.ts](/home/user/steelo-invoice/apps/worker/src/services/anomaly-baseline-job.ts:79)
  - [048_phase3_intelligence.sql](/home/user/steelo-invoice/packages/db/migrations/048_phase3_intelligence.sql:30)
- 問題:
  - `taskGroup` で `task_name=null` も task baseline として作れます。
  - その後同 driver に driver fallback も `taskName: null` で INSERT します。
  - partial unique index `WHERE task_name IS NULL` は両者を同一扱いします。
- 影響:
  - task 名欠損データが一定数ある driver で baseline recompute が INSERT 失敗します。
- 推奨対応:
  - `task_name IS NULL` の task baseline を作らない。
  - または NULL task と fallback をデータモデル上分ける。

---

### **[HIGH] Phase 3 cron 分岐の前で Phase 1/2 scheduled 処理が無条件実行される**

- ファイル:
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:820)
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:927)
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:1006)
- 問題:
  - Phase 3 の `event.cron` 分岐は後半だけです。
  - その前に delivery / health / refresh / payment recovery / reconciliation recovery / fallback / LLM fallback が毎 scheduled invocation で走ります。
  - wrangler は Phase 3 で `*/1`, `0 0 1 * *` を追加済みです。
- 影響:
  - 「毎 cron で全部走らせない」原則に反します。
  - 毎分 cron で Phase 1/2 の fallback が増え、DB 負荷、LINE 処理、ジョブ回収頻度が意図より増えます。
- 推奨対応:
  - `scheduled()` を cron ごとの handler に分割する。
  - 少なくとも Phase 1/2 の 5 分系処理は `event.cron === '*/5 * * * *'` に閉じる。

---

### **[HIGH] `/reports` UI の download は API key 名が違い、Bearer proxy download が失敗する**

- ファイル:
  - [api.ts](/home/user/steelo-invoice/apps/web/src/lib/api.ts:84)
  - [api.ts](/home/user/steelo-invoice/apps/web/src/lib/api.ts:2073)
- 問題:
  - 通常 API は `localStorage.getItem('lh_api_key')` を使います。
  - report download だけ `localStorage.getItem('apiKey')` を使っています。
- 影響:
  - API 自体が正しくても、管理画面のダウンロードボタンから Bearer が付かず PDF download が失敗します。
- 推奨対応:
  - `getApiKey()` を download 経路でも再利用する。

---

### **[HIGH] report job の source snapshot が実際には snapshot になっていない**

- ファイル:
  - [report-job.ts](/home/user/steelo-invoice/apps/worker/src/services/report-job.ts:116)
  - [report-jobs.ts](/home/user/steelo-invoice/packages/db/src/report-jobs.ts:55)
- 問題:
  - `source_reconciliation_job_id` は job 作成時に固定しています。
  - しかし PDF 作成時の rows query は `r.status = 'active'` を条件にしています。
  - 同 period の新しい reconciliation が走ると、古い source job の rows は archived になり得ます。
- 影響:
  - queue 遅延や再照合のタイミング次第で、PDF がサマリー件数だけ埋まり詳細行が空になる可能性があります。
- 推奨対応:
  - source job id で絞るなら `status='active'` 依存を外す。
  - もしくは report 作成時に report 用 snapshot を別保持する。

---

### **[HIGH] P0 PDF が要求する「warning 一覧」を実際には出していない**

- ファイル:
  - [reconciliation-report.ts](/home/user/steelo-invoice/apps/worker/src/services/pdf-templates/reconciliation-report.ts:88)
  - [reconciliation-report.ts](/home/user/steelo-invoice/apps/worker/src/services/pdf-templates/reconciliation-report.ts:121)
- 問題:
  - テンプレートは warning type の件数集計だけ描画しています。
  - `rows[].warnings` は report data に載せていますが、テンプレートでは使っていません。
- 影響:
  - Phase 3 P0 の「異常 warning 一覧」レポートとしては不足です。
  - 管理者は PDF だけではどの行が異常か追えません。
- 推奨対応:
  - detail table に warning type/severity を出す。
  - 最低でも warning 行一覧を別セクションで描画する。

---

### **[HIGH] LLM 失敗 streak は「連続失敗」ではなく「24h 内 failed 件数」になっている**

- ファイル:
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:1098)
- 問題:
  - 実装は `status='failed'` の count が 5 以上かだけ見ています。
  - spec は「5 件連続失敗」です。
- 影響:
  - 成功を挟んでいても通知され、API key 失効検知の意味がずれます。
- 推奨対応:
  - 直近 parse result を時系列で見て成功で streak を切る。
  - あるいは spec を「24h failed 件数」に変更する。

---

### **[HIGH] LLM 24h 判定は timestamp 文字列形式が揃っておらず境界が危うい**

- ファイル:
  - [047_phase2_reconciliation.sql](/home/user/steelo-invoice/packages/db/migrations/047_phase2_reconciliation.sql:26)
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:1105)
- 問題:
  - `llm_parse_results.created_at` は `YYYY-MM-DDTHH:mm:ss...` 形式です。
  - query は `datetime('now', '-1 day')` の SQLite 形式と TEXT 比較しています。
- 影響:
  - 24h window の境界が lexical compare 依存でずれます。
- 推奨対応:
  - query cutoff をアプリ側で同じ timestamp 形式に作って bind する。
  - あるいは SQLite の `datetime(created_at)` へ寄せる前提を検証する。

---

### **[HIGH] notification settings UI は raw target を返さない API と噛み合っていない**

- ファイル:
  - [notification-settings.ts](/home/user/steelo-invoice/apps/worker/src/routes/notification-settings.ts:51)
  - [page.tsx](/home/user/steelo-invoice/apps/web/src/app/settings/notifications/page.tsx:197)
  - [page.tsx](/home/user/steelo-invoice/apps/web/src/app/settings/notifications/page.tsx:84)
- 問題:
  - API は安全のため `lineTargetId: null` を常に返します。
  - UI は `!settings.settings.lineTargetId` でテスト送信ボタンを disabled にします。
  - UI の save は空欄時に `lineTargetId` を body に含めないため、画面から無効化もできません。
- 影響:
  - 保存済み target があっても UI のテスト送信ボタンが使えません。
  - 「null でリセット可能」という API 契約が UI から達成できません。
- 推奨対応:
  - `lineTargetIdMasked` の有無で test button を判定する。
  - 無効化ボタンや explicit clear action を UI に置く。

---

# MEDIUM

### **[MEDIUM] 5MB 超 PDF の warn ログ要件が未実装**

- ファイル:
  - [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:325)
  - [pdf-generator.ts](/home/user/steelo-invoice/apps/worker/src/services/pdf-generator.ts:84)
  - [report-job.ts](/home/user/steelo-invoice/apps/worker/src/services/report-job.ts:191)
- 問題:
  - byte size は計測していますが 5MB 超時の warn がありません。
- 影響:
  - 運用監視前提が spec とずれます。
- 推奨対応:
  - R2 PUT 前後で `result.byteSize` を見て warn を出す。

---

### **[MEDIUM] PDF の generatedAt が UTC 値なのに `JST` と表示される**

- ファイル:
  - [report-job.ts](/home/user/steelo-invoice/apps/worker/src/services/report-job.ts:170)
- 問題:
  - `new Date().toISOString()` は UTC です。
  - 末尾に文字列で `JST` を付けています。
- 影響:
  - PDF の生成日時が 9 時間ずれて表示されます。
- 推奨対応:
  - `jstNow()` か Intl formatter で JST 表示を作る。

---

### **[MEDIUM] PDF summary page の footer は placeholder と確定値を二重描画する**

- ファイル:
  - [reconciliation-report.ts](/home/user/steelo-invoice/apps/worker/src/services/pdf-templates/reconciliation-report.ts:119)
  - [reconciliation-report.ts](/home/user/steelo-invoice/apps/worker/src/services/pdf-templates/reconciliation-report.ts:163)
- 問題:
  - summary page に最初 `1 / 1` を描き、その後全 page に確定 page number を再描画しています。
- 影響:
  - 2 ページ以上で summary footer が重なります。
- 推奨対応:
  - placeholder draw を削除し、最後の一括描画だけにする。

---

### **[MEDIUM] LINE target ID の server validation が spec より弱い**

- ファイル:
  - [notification-settings.ts](/home/user/steelo-invoice/apps/worker/src/routes/notification-settings.ts:110)
- 問題:
  - prefix と `length >= 9` しか見ていません。
  - spec / UI は 33 文字前提です。
- 影響:
  - 明らかに壊れた ID が保存され、dispatcher 側の 4xx で初めて発覚します。
- 推奨対応:
  - User / Group / Room ID の長さ・文字種を server 側で揃える。

---

### **[MEDIUM] PUT 保存時の自動テスト通知は `reconciliation_completed` enabled でないと飛ばない**

- ファイル:
  - [notification-settings.ts](/home/user/steelo-invoice/apps/worker/src/routes/notification-settings.ts:166)
- 問題:
  - target を保存しても monthly reminder だけ enabled の場合、自動 test enqueue がありません。
- 影響:
  - 「設定保存時にテスト push」という要件とずれます。
- 推奨対応:
  - test event を通常 enabledEvents と切り離す。

---

### **[MEDIUM] target/token 未設定時は notification を skipped にせず pending に溜め続ける**

- ファイル:
  - [notification-dispatcher.ts](/home/user/steelo-invoice/apps/worker/src/services/notification-dispatcher.ts:74)
- 問題:
  - `line_target_id` や token が無い時点で claim せず return します。
- 影響:
  - 無効期間に溜まった古い monthly reminder / reconciliation completed が、設定投入後に遅れて届き得ます。
- 推奨対応:
  - 「無効時は送らない」を skip として確定するか、「後で送る」を docs/spec に明記する。

---

### **[MEDIUM] `last_test_at` が通常通知の sent でも更新される**

- ファイル:
  - [notification-dispatcher.ts](/home/user/steelo-invoice/apps/worker/src/services/notification-dispatcher.ts:150)
  - [notification-settings.ts](/home/user/steelo-invoice/packages/db/src/notification-settings.ts:89)
- 問題:
  - 全 sent 通知で `recordTestResult()` を呼んでいます。
- 影響:
  - `last_test_at` が「テスト通知の時刻」ではなく「最後に何か送れた時刻」になります。
  - 通常通知成功で `last_error` も消えます。
- 推奨対応:
  - payload の `isTest` 等で test sent だけ更新する。

---

### **[MEDIUM] idempotency duplicate の audit skip が呼び出し側で捨てられている**

- ファイル:
  - [notification-deliveries.ts](/home/user/steelo-invoice/packages/db/src/notification-deliveries.ts:43)
  - [reconciliation-job.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation-job.ts:128)
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:1040)
- 問題:
  - `enqueueDelivery()` は `inserted` を返します。
  - 主要 enqueue 呼び出しはその結果を使って skip audit を残していません。
- 影響:
  - spec にある「重複 skip の監査」が満たせません。
- 推奨対応:
  - `inserted=false` を呼び出し側で audit に落とす。

---

### **[MEDIUM] `/reports` API は未対応 report type のエラー契約が不揃い**

- ファイル:
  - [routes/reports.ts](/home/user/steelo-invoice/apps/worker/src/routes/reports.ts:22)
  - [report-jobs.ts](/home/user/steelo-invoice/packages/db/src/report-jobs.ts:85)
  - [report-job.ts](/home/user/steelo-invoice/apps/worker/src/services/report-job.ts:56)
- 問題:
  - `client_summary` は source があれば job 作成後に async failed。
  - `payment_summary` は `createReportJob()` が generic Error を投げ、route では 500。
- 影響:
  - Phase 3 P0 リリースの API 契約が読みづらく、UI 以外の caller が迷います。
- 推奨対応:
  - Phase 3 で受ける report type を `reconciliation` に絞るか、未対応は明示 501/422 に揃える。

---

### **[MEDIUM] report POST の bad JSON は 400 ではなく 500 になる**

- ファイル:
  - [routes/reports.ts](/home/user/steelo-invoice/apps/worker/src/routes/reports.ts:31)
- 問題:
  - `c.req.json()` の parse error を input error として分けていません。
- 影響:
  - bad input の API 分岐観点が完全ではありません。
- 推奨対応:
  - JSON parse failure を 400 に落とす。

---

### **[MEDIUM] notification dispatcher の本体処理テストが薄い**

- ファイル:
  - [notification-dispatcher.ts](/home/user/steelo-invoice/apps/worker/src/services/notification-dispatcher.ts:50)
  - [phase3-integration.test.ts](/home/user/steelo-invoice/apps/worker/src/phase3-integration.test.ts:108)
- 問題:
  - `claimBatch`, cooldown, stale recovery はあります。
  - しかし dispatcher 本体の `max attempts`, `not enabled`, `target missing`, audit payload, 4xx/5xx requeue の結合が未検証です。
- 影響:
  - F9 の本番障害時の振る舞いにテストの空白があります。
- 推奨対応:
  - notifier mock 注入か fetch stub で dispatcher end-to-end を追加する。

---

### **[MEDIUM] Phase 3 cron event 分岐の integration test が見当たらない**

- ファイル:
  - [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:820)
  - [phase3-integration.test.ts](/home/user/steelo-invoice/apps/worker/src/phase3-integration.test.ts:1)
- 問題:
  - `scheduled()` で `event.cron` ごとにどの処理が呼ばれるかのテストがありません。
- 影響:
  - 今回の「毎 cron で既存処理が走る」回帰をテストが止められていません。
- 推奨対応:
  - cron ごとの spy ベースの scheduled integration test を置く。

---

### **[MEDIUM] report route の 422 / 409 / download / enqueue failure の route-level test が不足**

- ファイル:
  - [routes/reports.ts](/home/user/steelo-invoice/apps/worker/src/routes/reports.ts:31)
  - [phase3-integration.test.ts](/home/user/steelo-invoice/apps/worker/src/phase3-integration.test.ts:344)
- 問題:
  - DB helper test はあります。
  - route の status code と Bearer download path の検証が見当たりません。
- 影響:
  - UI/API/DB 三層の契約崩れを検知できません。
- 推奨対応:
  - Hono route test で 400/409/422/download まで固定する。

---

### **[MEDIUM] PDF 構造テストが font fixture 無しで skip される**

- ファイル:
  - [pdf-generator.test.ts](/home/user/steelo-invoice/apps/worker/src/services/pdf-generator.test.ts:44)
- 問題:
  - font fixture が無い環境では page count / render structure が skip です。
- 影響:
  - CI で PDF の最重要レンダリング退行を見逃します。
- 推奨対応:
  - CI fixture を確実に同梱する。
  - さらに `FONT_NOT_FOUND` 実 generator path の test を足す。

---

### **[MEDIUM] SQLite D1 test helper の `batch()` が transaction を再現していない**

- ファイル:
  - [sqlite-d1.ts](/home/user/steelo-invoice/packages/db/src/test-helpers/sqlite-d1.ts:111)
  - [anomaly-baselines.ts](/home/user/steelo-invoice/packages/db/src/anomaly-baselines.ts:38)
- 問題:
  - helper は statement を順に `run()` するだけです。
- 影響:
  - `replaceBaselinesAtomic()` や report recovery で「batch atomic」をテストで証明できません。
- 推奨対応:
  - helper の batch を SQLite transaction で包む。
  - 失敗時 rollback test を足す。

---

### **[MEDIUM] `claimBatch` の同時 cron 競合テストは D1 競合性を確認していない**

- ファイル:
  - [phase3-integration.test.ts](/home/user/steelo-invoice/apps/worker/src/phase3-integration.test.ts:128)
  - [notification-deliveries.ts](/home/user/steelo-invoice/packages/db/src/notification-deliveries.ts:110)
- 問題:
  - テストは sequential claim です。
- 影響:
  - 本番 D1 concurrency の実挙動検証が acceptance/manual に残ります。
- 推奨対応:
  - D1 staging で concurrent claim smoke を gate に入れる。
  - 少なくとも SQL の single statement 性をコメントだけでなく test plan に明記する。

---

# Cross-phase 整合性指摘

1. `reconciliations.warnings` の backward compatibility は read path では整っています。  
   `routes/reconciliations.ts` と `report-job.ts` が `parseWarnings()` を通しているため、旧 `string[]` と新 structured warnings の混在を吸収できます。  
   [routes/reconciliations.ts](/home/user/steelo-invoice/apps/worker/src/routes/reconciliations.ts:30)  
   [report-job.ts](/home/user/steelo-invoice/apps/worker/src/services/report-job.ts:147)

2. `InsertReconciliationInput.warningsJson` も「DB に入れるのは serialized TEXT」という境界に寄っており、DB schema の TEXT 維持と整合しています。  
   [reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:40)

3. `LINE_CHANNEL_ACCESS_TOKEN` の流用前提は危険ではないが、channel 境界を明記すべきです。  
   Phase 3 push は [notification-dispatcher.ts](/home/user/steelo-invoice/apps/worker/src/services/notification-dispatcher.ts:75) で env token だけを使います。  
   Phase 1 の LINE 受信・複数 line account 運用と混ざる場合、**登録した target ID がその token の bot から push 可能な相手か**を運用手順で固定する必要があります。

4. Phase 2 LLM failure 通知は Phase 2 table を読むため、Phase 2 timestamp 形式と Phase 3 cooldown timestamp 形式の違いを放置しない方がよいです。

---

# Docs / Ops 指摘

### 1. Phase 3 spec 群に Slack 記述が大量に残っている

- [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:6)
- [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:129)
- [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:320)
- [schema.sql](/home/user/steelo-invoice/packages/db/schema.sql:1211)

requirements の中盤は LINE に切り替わっていますが、design/tasks/schema comments は Slack 前提がかなり残っています。  
「歴史的 spec」と「現実装」の差異を明示するだけでは足りず、最終 gate では **現行仕様ドキュメントを LINE に一本化**した方がよいです。

---

### 2. deployment の migration 順序説明が Phase 3 最終投入向けになっていない

- [deployment.md](/home/user/steelo-invoice/docs/operations/deployment.md:114)
- [deployment.md](/home/user/steelo-invoice/docs/operations/deployment.md:347)

上部 §3 は `046 → 047` までしか厳守と書いていません。  
Phase 3 追補 §8.5 に `048` はありますが、本番直前 runbook としては `046 → 047 → 048` を一箇所で示す方が安全です。

---

### 3. deployment 完了判定が Phase 1 + Phase 2 のまま

- [deployment.md](/home/user/steelo-invoice/docs/operations/deployment.md:439)

Phase 3 追加後の最終判定なのに「Phase 1 + Phase 2 本番投入完了」となっています。

---

### 4. phase3 acceptance と実装の status code / retry 挙動がずれている

- [phase3-acceptance.md](/home/user/steelo-invoice/docs/operations/phase3-acceptance.md:137)
- [notification-settings.ts](/home/user/steelo-invoice/apps/worker/src/routes/notification-settings.ts:223)

`POST /api/notification-settings/test` は doc で 202 とありますが route は 200 です。

また:
- [phase3-acceptance.md](/home/user/steelo-invoice/docs/operations/phase3-acceptance.md:208)
- [line-notifier.ts](/home/user/steelo-invoice/apps/worker/src/services/line-notifier.ts:102)

token 失効は通常 401 なので実装では immediate failed です。acceptance の「pending で token 復活後再送」は 5xx/timeout 側の挙動です。

---

### 5. cron triggers 4 本の plan/limit 確認が runbook gate に弱い

- [deployment.md](/home/user/steelo-invoice/docs/operations/deployment.md:389)
- [phase3-acceptance.md](/home/user/steelo-invoice/docs/operations/phase3-acceptance.md:17)

4 cron 登録確認はありますが、Cloudflare plan / cron 制限 / cost 想定の確認欄がありません。  
本番投入チェックとしては「Dashboard で 4 本見える」だけでなく、対象環境でその構成が許可されることを gate に入れるべきです。

---

# 実装着手前の本番投入判定

## 🔴 未通過

理由:
1. `anomaly_baselines` の世代管理矛盾で月次 recompute が本番継続運用に耐えません。  
2. Phase 3 cron 追加で Phase 1/2 scheduled 処理が毎分側にも流れ込みます。  
3. PDF report は UI download と source snapshot に本番影響のある不整合があります。

---

# 検証メモ

対象コード・spec・docs・test を静的精査しました。  
targeted test も実行を試しましたが、read-only filesystem のため Vitest が `vitest.config.ts.timestamp-*.mjs` を生成できず起動失敗しました。

実行試行:
```sh
pnpm -F worker test -- \
  src/services/anomaly-detector.test.ts \
  src/services/parse-warnings.test.ts \
  src/services/line-notifier.test.ts \
  src/phase3-integration.test.ts
```

失敗理由:
```text
EROFS: read-only file system
```

---

# 今の進捗を全体像から整理するとこれ

- Phase 1: 過去レビュー反映済みの主要処理は大きく崩れていない。
- Phase 2: warnings 後方互換は概ね整合。
- Phase 3 F8: detector 本体は良いが、baseline 永続化設計が gate blocker。
- Phase 3 F9: claim/retry 骨格はあるが、cron 分岐、streak 定義、設定 UI/運用整合に修正が必要。
- Phase 3 F10: PDF 基盤はあるが、download UI、snapshot、warning 一覧で修正が必要。
- Docs/Ops: Slack → LINE 切替後の最終仕様整理がまだ終わっていない。

---

# 次のタスクはこれ

1. `anomaly_baselines` を「現行 1 世代保持」か「period 世代保持」か決めて migration / query / recompute を一貫させる。  
2. `scheduled()` を cron ごとに分離し、`*/1` で notification dispatcher 以外が走らないことを test で固定する。  
3. `/reports` の `lh_api_key` download 修正、report source rows の snapshot 修正、PDF warning 一覧描画をまとめて直す。  
4. その後、route-level tests と phase3 acceptance docs を現実装に合わせて締め直す。