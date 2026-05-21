## サマリー

Phase 3 の方向性は妥当です。F8 異常検知、F9 Slack 通知、F10 PDF レポートは Phase 1+2 の運用を次段に進める機能ですが、現状 spec は **実装開始前に直すべき CRITICAL が複数残っています**。

特に危ないのは、`warnings` の破壊的変更、異常検知の数式定義、Slack retry と `waitUntil` の時間設計、PDF 日本語フォント、`report_jobs` の queue / 排他 / 復旧設計です。Phase 1+2 で一度潰した種類の事故が再発しそうな箇所があるため、今のまま実装へ入るのは早いです。

## 指摘事項

### 1. **[CRITICAL] fare deviation の判定式が単位不整合で、実装者が別々の判定を作る**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 1.3-1.4、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): `anomaly-detector.ts`

問題: `"(fare - median) / median が ±2 SD を超えたら"` は、左辺が割合、`SD` が金額なので単位が合いません。一方、例の `deviation_sigma: 18.75` は `(fare - median) / sd` を意図しているように読めます。

影響: 実装者が `relative deviation` と `z-score` のどちらを採用するかで検出結果が変わります。異常検知の中核判定がぶれます。

推奨対応: spec を次のどちらかに固定してください。  
- `abs(fare - median_fare) / sd_fare >= 2` を `deviation_sigma` とする  
- しきい値を割合にするなら `abs(fare - median_fare) / median_fare >= relative_threshold` とし、SD を判定に使わない

---

### 2. **[CRITICAL] `reconciliations.warnings` の後方互換が optional migration に依存している**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 8.2-8.3、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Data Models、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 2.4 / 2.7

問題: Phase 2 では shared 型も API serialize も `warnings: string[]` 前提です。現行コードも [phase2.ts](/home/user/steelo-invoice/packages/shared/src/phase2.ts:72)、[routes/reconciliations.ts](/home/user/steelo-invoice/apps/worker/src/routes/reconciliations.ts:26)、[reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:40) で文字列配列を扱っています。spec は「任意の再計算スクリプト」で逃がしていますが、未実行時の API / UI 契約が明文化されていません。

影響: 既存行を読む画面、PDF、Slack 集計が `string` と structured object の混在で壊れます。Phase 2 データが残る本番では高確率で踏みます。

推奨対応: spec に `parseWarnings()` の互換仕様を追加してください。  
- 入力 `string[] | StructuredWarning[] | null` を許容  
- 旧文字列は `type: 'legacy_warning'` または既知文字列マッピングで構造化  
- API レスポンスは Phase 3 以降常に `StructuredWarning[]`  
- migration は最適化であって必須条件にしない

---

### 3. **[CRITICAL] `pdf-lib` の日本語フォント埋込に必要な `@pdf-lib/fontkit` が spec から抜けている**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 6.3、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Allowed Dependencies / PDF、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 1.3 / 4.1

問題: spec は `pdf-lib` と `embedFont()` だけを書いていますが、`pdf-lib` の custom font 埋込は `@pdf-lib/fontkit` を追加し `pdfDoc.registerFontkit(fontkit)` する必要があります。日本語は標準フォントでは扱えません。

影響: Noto Sans JP を R2 から取れても日本語 PDF 生成が実行時に失敗する可能性が高いです。

推奨対応: Allowed Dependencies と tasks に以下を追加してください。  
- `@pdf-lib/fontkit` を導入  
- `pdfDoc.registerFontkit(fontkit)` を `pdf-generator.ts` の責務にする  
- Workers 上で Noto Sans JP を含む PDF を生成する integration test を必須化

---

### 4. **[CRITICAL] Slack retry 設計が `waitUntil` の制限と衝突している**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 3.3 / 7.3、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): F9 Slack 通知フロー / Error Handling、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 3.2 / 3.4

問題: backoff が `1s + 5s + 30s = 36s` で、`waitUntil` の実行猶予 30 秒を超えます。Cloudflare docs でも `waitUntil` は invocation 終了後 30 秒でキャンセルされ得るため、今の retry は最後まで走る保証がありません。

影響: Slack 失敗ログが残らない、最後の retry が飛ばない、通知成功率が環境依存になります。

推奨対応: spec を次のどちらかに寄せてください。  
- Slack 通知は `notification_jobs` または Queue に積み、retry / DLQ / recovery を持つ  
- `waitUntil` でやるなら retry を `1s + 3s + 8s` 程度に制限し、失敗時は次回 cron 再送に切る

---

### 5. **[CRITICAL] `reconciliation-job.ts` から Slack を `waitUntil` する設計が既存実装の呼び出し境界と合っていない**

該当ファイル: [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 3.4、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): F9 Slack 通知フロー

問題: 既存の [reconciliation-job.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation-job.ts:20) は `env` と payload だけを受け、`ExecutionContext` を持ちません。queue consumer 経路でも [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:1000) は job に context を渡していません。

影響: 実装時に通知を `await` して照合ジョブを遅くするか、context を無理に通すか、通知を落とすかのどれかになりやすいです。

推奨対応: spec にイベント境界を追加してください。  
- `reconciliation completed` 後に通知イベントを別キューへ積む  
- 照合ジョブは通知送信ではなく「通知要求の永続化」までを責務にする

---

### 6. **[CRITICAL] `report_jobs` が Phase 2 で潰したジョブ排他・復旧パターンを再発させている**

該当ファイル: [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): `report_jobs` Data Model、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 4.6-4.8

問題: Phase 2 の `reconciliation_jobs` は `active_period_key` UNIQUE、enqueue 失敗時 failed、stuck recovery を持っています。現行 `report_jobs` には同等の排他キー、enqueue 失敗処理、stuck recovery が spec 化されていません。既存パターンは [047_phase2_reconciliation.sql](/home/user/steelo-invoice/packages/db/migrations/047_phase2_reconciliation.sql:38)、[routes/reconciliations.ts](/home/user/steelo-invoice/apps/worker/src/routes/reconciliations.ts:213)、[reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:492) にあります。

影響: 同じ月・同じ種別 PDF の連打生成、`queued` 放置、`running` 固着が起きます。

推奨対応: `report_jobs` に最低限以下を spec 化してください。  
- `active_report_key = period || ':' || report_type` for `queued/running`  
- `UNIQUE(active_report_key)`  
- enqueue 失敗時 `failed`  
- cron recovery で古い `running` を `failed`  
- Queue DLQ または再投入経路

---

### 7. **[CRITICAL] report job を既存 `reconciliation-queue` に流用する案が payload と consumer 分岐に合っていない**

該当ファイル: [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Technology Stack / F10 PDF Flow、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 4.7

問題: 既存 consumer は queue name が `reconciliation-queue` なら `runReconciliationJob()` に固定分岐しています。[index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:996) 同じ `{ jobId }` payload で report job を流すと誤ルーティングします。

影響: report job が reconciliation job として読まれ、`not found` または誤処理になります。

推奨対応: spec でどちらかに固定してください。  
- `REPORT_QUEUE` を別 queue として作る  
- 同一 queue を使うなら payload を `{ kind: 'report' | 'reconciliation', jobId }` にし、consumer / DLQ / fallback を明記

---

### 8. **[HIGH] `anomaly_baselines UNIQUE(driver_id, task_name)` は `task_name=NULL` の fallback 行を一意にできない**

該当ファイル: [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Data Models、[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 8.1

問題: SQLite 系では UNIQUE 制約上の `NULL` は同値衝突扱いにならないため、`driver_id` が同じ fallback row を複数持てます。

影響: `task_name=null` の driver fallback baseline が複数でき、Map 化時に選ばれる baseline が不安定になります。

推奨対応: partial unique index を使う spec にしてください。  
- `UNIQUE(driver_id, task_name) WHERE task_name IS NOT NULL`  
- `UNIQUE(driver_id) WHERE task_name IS NULL`  
または `baseline_key` generated column を作り `NULL` を `_all_` に正規化してください。

---

### 9. **[HIGH] baseline fallback の境界条件が不足している**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 1.2、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 2.2

問題: 「task group が 5 未満なら driver 全体へ fallback」「3 未満なら baseline 無し」の主語が曖昧です。`driver × task = 4 件`、`driver 全体 = 2 件`、`driver × task = 2 件` だが `driver 全体 = 20 件` のような境界が未定義です。

影響: しきい値境界で detector と baseline job の実装がずれます。

推奨対応: 優先順位表を spec に追加してください。例:  
1. `driver × task >= 5` は task baseline  
2. それ未満で `driver all >= 3` は driver fallback  
3. それ以外は skip  
さらに `sample_size` は実際に使った baseline のサンプル数と明記してください。

---

### 10. **[HIGH] `dispatch_overload` は現在の detector interface では判定できない**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 2.3、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): `AnomalyInput`

問題: interface は 1 reconciliation 行の `dispatch` / `client` を渡す形です。しかし overload は「同 driver × 同日に dispatch 3 件以上」という集計条件です。

影響: 実装時に detector が DB を読む純粋関数でなくなるか、overload 判定が抜けます。

推奨対応: spec を変えてください。  
- `AnomalyContext` に `dispatchCountByDriverDate` を渡す  
- もしくは reconciliation job 前処理で overload warning を precompute する  
- `dispatch_only` 行でも warning を出すか明記する

---

### 11. **[HIGH] `time_inversion` の 12 時間判定が曖昧で、過去の time 比較バグを再発させやすい**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 2.1、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 2.1

問題: `start_time > end_time` と「時刻差が 12 時間以内かどうか」の組み合わせで、`23:00 -> 11:00`、`12:00 -> 00:00`、invalid time、秒付き時刻の扱いが未定義です。既存コードは parse helper を持っていますが、spec が string compare 実装を誘発します。[reconciliation.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation.ts:266)

影響: 日跨ぎ除外と異常判定が境界でぶれます。

推奨対応: spec に minute-based algorithm を書いてください。例:  
- `HH:mm` を 0-1439 分へ parse  
- parse 失敗は skip  
- `start <= end` は正常  
- `start > end` かつ `start - end < 720` は inversion  
- `start - end >= 720` は overnight と扱う  
境界 `720` をどちらに含めるかも明記してください。

---

### 12. **[HIGH] Phase 3 API ルートが STEELO 専用 CORS prefix へ追加されるタスクがない**

該当ファイル: [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md)、既存 [steelo-cors.ts](/home/user/steelo-invoice/apps/worker/src/middleware/steelo-cors.ts:22)

問題: 既存 Worker は `/api/*` 認証は掛かりますが、STEELO PII 系 API は `STEELO_PATH_PREFIXES` で CORS を絞っています。Phase 3 の `/api/reports`、`/api/notification-settings`、`/api/anomaly-baselines` を追加する task がありません。

影響: 新 API が既存の STEELO CORS 制限から漏れ、グローバル CORS 側に流れます。

推奨対応: Foundation task に以下を追加してください。  
- `STEELO_PATH_PREFIXES` に Phase 3 route prefix 追加  
- CORS unit test で Phase 3 API が許可 origin 限定であることを確認

---

### 13. **[HIGH] monthly reminder と LLM failed streak に通知重複防止がない**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 4.3-4.4、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 3.5-3.6

問題: cron 再実行、scheduled overlap、Slack retry 後の再実行に対する idempotency がありません。LLM failure streak は毎 5 分評価すると、同じ障害で何度も通知できます。

影響: 月初 reminder の二重送信、障害時の Slack spam が起きます。

推奨対応: `notification_deliveries` 相当の送信履歴を spec に追加してください。  
- idempotency key 例: `monthly_reminder:2026-04`  
- streak 例: `llm_failed_streak:<window_end_bucket>`  
- 再送可否と cooldown を明記

---

### 14. **[HIGH] PDF download の signed URL 設計が既存実装方針とズレている**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 5.3、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): F10 PDF Flow

問題: 既存 Phase 1 の download は「Workers 標準 R2 APIには署名 URL 生成を置かず、Bearer 必須 proxy DL」で実装されています。[payment-summaries.ts](/home/user/steelo-invoice/apps/worker/src/routes/payment-summaries.ts:113) 一方 Phase 3 は `createPresignedUrl` のように読めます。R2 presigned URL は S3 API credential と SigV4 前提なので、どの credential を Worker に置くか、S3 endpoint を出すかが spec にありません。

影響: 実装が Phase 1 と別方式に分岐し、secret 管理・監査・URL 漏洩リスクの議論が抜けます。

推奨対応: spec で次を選んでください。  
- Phase 1 と同じ authenticated proxy download  
- R2 presigned URL を採用し、credential 管理、URL logging 禁止、expiry、revocation limitation を明記

---

### 15. **[MEDIUM] Slack webhook の「encrypted at rest」表現が秘密情報保護として曖昧**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 3.1、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Security Considerations

問題: requirements は `encrypted at rest via Workers KV or D1` と書き、design は「D1 に平文保存」と書いています。D1 自体は Cloudflare 管理で encryption-at-rest がありますが、それは「DB 参照権限を持つ主体から webhook secret を隠す列暗号化」ではありません。

影響: レビュー時に「D1 平文保存でよいのか」「アプリ側暗号化が必要なのか」が判断できません。

推奨対応: spec を明確化してください。  
- Phase 3 は D1 平文列 + D1 EAR + GET mask + audit redaction で許容する  
または  
- `SLACK_WEBHOOK_ENCRYPTION_KEY` でアプリ層暗号化する  
どちらかを選び、エラーログ・last_error に URL や Slack response body を入れないことも明記してください。

---

### 16. **[MEDIUM] `advance_payment_without_dispatch` から `advance_payment_without_label` への意味変更が未定義**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 2.2、既存 [reconciliation.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation.ts:295)

問題: Phase 2 は「立替金があり dispatch にマッチしない」を warning にしています。Phase 3 は「立替金があり dispatch task_name にラベルがない」を出す設計です。置換なのか追加なのかが書かれていません。

影響: 既存運用で見えていた未マッチ立替 warning が消える可能性があります。

推奨対応: spec に compatibility decision を追加してください。推奨は追加です。  
- `advance_payment_without_dispatch` は warn または info で維持  
- `advance_payment_without_label` は matched 行向け info  
- 旧 warning migration map を明記

---

### 17. **[MEDIUM] PDF の性能・サイズ要件が現実のボトルネックを切り分けていない**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 5.5 / 7.2 / 7.4、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Performance

問題: `200 行 30 秒` は目標としてよいですが、`>500 行は Queues で分割処理` は PDF 1 ファイル生成の分割戦略が未定義です。PDF serialize は CPU を食う可能性があり、Workers の default CPU limit は 30 秒です。R2 object size は 5MB よりかなり大きい上限を持つので、5MB fail は R2 上限対策ではなく業務上限として書くべきです。

影響: 実装後に「queue にしたのに serialize で CPU 超過」「5MB で不要 fail」が起きます。

推奨対応: spec を次の形にしてください。  
- 200 行 / 500 行の benchmark fixture を定義  
- CPU 時間、生成 byte size、page count を測定  
- 大規模データ時は `fail with actionable error` か `report type ごと分割` かを選ぶ  
- 5MB は「運用上の警告閾値」と表現する

---

### 18. **[MEDIUM] PDF test 方針が snapshot に寄りすぎている**

該当ファイル: [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): Testing Strategy、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Task 4.2

問題: PDF binary snapshot は metadata、object ordering、font subset などで壊れやすいです。spec は「snapshot test」と書いていますが何を snapshot するか未定義です。

影響: CI が不安定になるか、逆に意味の薄い snapshot が残ります。

推奨対応: test spec を分けてください。  
- unit: page count、必要文字列、footer、font 埋込、table pagination  
- integration: R2 PUT、download response、byte size  
- visual regression は必要なら固定 fixture PDF の rendered image 比較に限定

---

### 19. **[MEDIUM] PDF がどの時点のデータを報告するか固定されていない**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 5、[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md): `report_jobs`

問題: レポート生成中に import batch 上書き、reconciliation rerun、payment summary 再生成が起きた場合、PDF が混ざった状態のデータを読む余地があります。

影響: 元請け提出 PDF と画面値の説明が合わなくなります。

推奨対応: `report_jobs` に source identity を残してください。例:  
- `import_batch_id`  
- `reconciliation_job_id`  
- `payment_job_id` または snapshot version  
少なくとも job 開始時に対象 source を固定する設計を追加してください。

---

### 20. **[LOW] F10 の 3 テンプレート同時実装は Phase 3 のリスクを増やしている**

該当ファイル: [requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md): Requirement 5、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md): Section 4

問題: PDF は Workers compatibility、日本語フォント、ページング、R2 配信まで未知が多いのに、最初から 3 種テンプレートを同時に実装する計画です。

影響: F10 が Phase 3 全体の完了を引っ張ります。

推奨対応: spec で優先度を付けてください。  
- P0: `照合結果レポート`  
- P1: `元請けサマリー`  
- P2: `支払明細サマリー`  
または Phase 3 の受入条件に「最初の 1 種で infra 検証完了」を入れてください。

---

## 補足評価

`notification_settings` の `id=1 CHECK` 自体は単一テナント前提なら許容できます。ただし spec には「DELETE させない」「GET は row 無し時に migration 不整合として扱う」「PUT は id=1 を固定 update」という運用ルールを一文入れると、実装の迷いが減ります。

異常検知の `median + SD` は、中央値を使っているのに SD は外れ値に引っ張られます。Phase 3 ではまず固定仕様でもよいですが、将来チューニング前提なら `threshold_sigma`、最低サンプル数、対象期間を設定テーブルまたは code constant として明示しておく方が Phase 4 へ繋がります。

## 次のタスクはこれ

まず spec を直す順番はこれです。

1. F8 の判定式、fallback 境界、time inversion 判定を `requirements.md` に確定させる  
2. `warnings` 後方互換、report job 排他・復旧、Slack 通知の queue/idempotency を `design.md` に入れる  
3. `fontkit`、Phase 3 CORS prefix、report queue、benchmark/test 方針を `tasks.md` に落とす  
4. その修正版 spec をもう 1 回レビューに通す

## 今の進捗を全体像から整理するとこれ

- Phase 1+2: 実装済み、本番品質に近い既存契約がある  
- Phase 3: `spec.json` 上も `initialized` で、まだ実装開始前  
- 今回のレビュー結果: **設計方向は良いが、実装前 gate は未通過**  
- 実装へ進める条件: 上の CRITICAL を spec 上で解消し、HIGH のうち queue / CORS / baseline / cron 重複を先に固めること