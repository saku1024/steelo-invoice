### サマリー

Phase 2 は骨格はできていますが、現状は Phase 1 で守った本番品質基準をまだ維持できていません。特に **LLM モデル ID の失効**, **LLM 解析結果から `dispatch_records` 生成までの非原子性**, **照合結果の archive → insert 非原子性** は本番投入前に止めるべき問題です。

一方で、Phase 2 ルートは STEELO CORS プレフィックスと共通 Bearer 認証配下に入り、Anthropic TypeScript SDK 自体も Cloudflare Workers 対応ランタイムに含まれています。問題の中心は SDK 採用ではなく、モデル寿命・再実行耐性・DB 整合性・運用復旧です。 

**今の進捗を全体像から整理するとこれ**:  
`F2/F4 の基本フローは実装済み` → `Phase 1 品質基準との差分レビュー完了` → `本番前に CRITICAL 3 件と HIGH 群を潰す段階` です。

---

### 指摘事項（優先度順）

- **[CRITICAL] 使用モデル `claude-3-haiku-20240307` はすでに retired 済み**
  - 該当ファイル: [llm-prompts.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-prompts.ts:12)
  - 問題: `MODEL_NAME` が Claude Haiku 3 固定です。Anthropic は **2026-04-20** にこのモデルを retired し、以後リクエストはエラーになると明記しています。
  - 影響: 本番の F2 LLM 解析が全件失敗します。仕様上の retryable 判定次第では queue 消費と失敗記録だけが進みます。
  - 推奨対応: `claude-haiku-4-5-20251001` など現行モデルへ移行し、prompt version と bench/golden を同時に更新してください。コスト定数もモデル単価に合わせて更新が必要です。 ([platform.claude.com](https://platform.claude.com/docs/en/release-notes/overview))

- **[CRITICAL] LLM 解析成功の永続化が非原子的で、retry 時に `dispatch_records` が重複する**
  - 該当ファイル: [llm-parser.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-parser.ts:167), [dispatch-records.ts](/home/user/steelo-invoice/packages/db/src/dispatch-records.ts:84)
  - 問題: `llm_parse_results` 成功 UPSERT、`dispatch_records` N 件 INSERT、confidence UPDATE、`line_messages.is_parsed` 更新が別々です。
  - 影響: 途中で 1 回失敗すると、次回 queue retry で既存 dispatch を見ずに再 INSERT します。Phase 1 で避けた「確定処理の途中失敗で二重生成」の再発です。
  - 推奨対応: `raw_message_id + task_number` などの idempotency key を設け、生成済み dispatch を上書き/再生成方針込みで 1 つの確定境界にしてください。

- **[CRITICAL] 照合結果の `archive → insert` が非原子的で active 結果が消える**
  - 該当ファイル: [reconciliation-job.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation-job.ts:50), [reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:59)
  - 問題: 旧 active 行を archive した後に、新行を 50 件ずつ別 `db.batch()` で insert しています。
  - 影響: insert 途中失敗で「旧 active は消えたが新 active は一部またはゼロ」の状態になります。これも Phase 1 の原子性基準から外れます。
  - 推奨対応: 新結果を staging 状態で全件作成し、最後に `archive old + activate new + job completed` を同一確定境界で実行してください。D1 の `batch()` はその batch 内で transaction として扱われます。 

- **[HIGH] Queue 利用時の LLM 失敗復旧設計が切れている**
  - 該当ファイル: [wrangler.toml](/home/user/steelo-invoice/apps/worker/wrangler.toml:58), [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:978)
  - 問題: `llm-parse-queue` に DLQ がなく、retry delay/backoff も設定されていません。さらに Scheduled fallback は `!env.LLM_PARSE_QUEUE` のときしか動きません。
  - 影響: 本番で queue がある環境では retry 上限後のメッセージが運用復旧経路から落ちます。Cloudflare Queues は DLQ 未設定だと retry 上限後に削除されます。
  - 推奨対応: `dead_letter_queue` を追加し、retry delay 方針を明示してください。fallback は「queue 未バインド時」だけでなく failed 未復旧ジョブの掃除経路も持つべきです。 

- **[HIGH] `queue.send()` 失敗で reconciliation job が queued のまま詰まる**
  - 該当ファイル: [reconciliations.ts](/home/user/steelo-invoice/apps/worker/src/routes/reconciliations.ts:184), [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:966), [reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:322)
  - 問題: job INSERT 後に `queue.send()` が失敗すると route は 500 ですが、job は `queued` のまま残ります。recovery は `running` のみ対象です。
  - 影響: `active_period_key` UNIQUE により同月再投入が 409 になり、しかも queue bound 環境では Scheduled fallback が queued job を拾いません。
  - 推奨対応: enqueue 失敗時は job を `failed` に倒す、または outbox 的に queued job を cron で再送する設計にしてください。

- **[HIGH] `llm_parse_results` UPSERT が select-then-insert で競合に弱い**
  - 該当ファイル: [llm-parse-results.ts](/home/user/steelo-invoice/packages/db/src/llm-parse-results.ts:37)
  - 問題: 先に SELECT して存在判定し、なければ INSERT しています。
  - 影響: queue の重複配信、reparse、同時 fallback で 2 invocation が `existing=null` を見た場合、片方が UNIQUE 例外になり、attempt_count と失敗履歴も不安定になります。
  - 推奨対応: SQLite の `INSERT ... ON CONFLICT(line_message_id) DO UPDATE SET attempt_count = attempt_count + 1` に寄せてください。

- **[HIGH] driver 解決失敗時に `is_parsed=1` だけ立ち、配車が消える**
  - 該当ファイル: [llm-parser.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-parser.ts:180)
  - 問題: LLM が `isDispatch=true` でも `baseDriverId` が null なら dispatch を 1 件も作らず、その後 `line_messages.is_parsed=1, is_dispatch=1` にします。
  - 影響: driver 未紐付けグループの配車が「解析済みなのに dispatch なし」で埋もれます。運用者に needs_review キューも出ません。
  - 推奨対応: driver unresolved を明示失敗または review 対象として残し、`is_parsed=1` で閉じないでください。

- **[HIGH] 手動 reparse が既存 dispatch を再利用せず再生成する**
  - 該当ファイル: [llm-parse.ts](/home/user/steelo-invoice/apps/worker/src/routes/llm-parse.ts:13), [llm-parser.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-parser.ts:180)
  - 問題: reparse は `is_parsed=0` に戻して同じ parse job を直実行しますが、過去に `raw_message_id` から作られた dispatch を archive/delete/replace しません。
  - 影響: 運用復旧手段である reparse 自体が重複レコード生成手段になります。
  - 推奨対応: reparse の意味を `replace generated dispatches` か `new parse result only` のどちらかに固定し、DB 操作もそれに合わせてください。

- **[HIGH] manual match が対象行・期間・相手レコードの整合性を検証していない**
  - 該当ファイル: [reconciliations.ts](/home/user/steelo-invoice/packages/db/src/reconciliations.ts:186), [reconciliations.ts](/home/user/steelo-invoice/apps/worker/src/routes/reconciliations.ts:142)
  - 問題: 渡された `dispatchId` / `clientRecordId` をそのまま既存 row に刺し、active 行か、同 period か、未使用か、元の match status と整合するかを検証していません。
  - 影響: 別月 dispatch と手動照合、同一 client の複数 active matched 行、論理的に壊れた reconciliation が作れます。
  - 推奨対応: 相手候補を DB で検証し、同 period・active・片側未マッチを条件に UPDATE してください。

- **[HIGH] 1 dispatch × N client で greedy 順序依存マッチになる**
  - 該当ファイル: [reconciliation.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation.ts:87)
  - 問題: client を順に見て、その時点で使える dispatch の best を即確定しています。
  - 影響: 先に fuzzy/time client が来て dispatch を消費すると、後続の strong client が `client_only` になります。テストも「最良スコアのみ採用」と書きつつ実際は client 順序依存です。
  - 推奨対応: 候補 edge を全件スコア化し、score 降順で 1 対 1 を確定する少なくとも greedy-on-edge に変えてください。

- **[HIGH] レコード不完全でも LLM confidence を信じて `status='auto'` にできる**
  - 該当ファイル: [llm-client.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-client.ts:171), [llm-parser.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-parser.ts:185)
  - 問題: prompt では「業務名と時刻のどちらか欠落なら low」と指示していますが、実装検証は confidence の enum 正規化だけです。
  - 影響: `taskName=null` や `startTime=null` の dispatch が `high/medium -> auto` で流れます。
  - 推奨対応: parser 側で必須度を検証し、欠落レコードを record 単位で `needs_review` に落としてください。

- **[MEDIUM] workDate 未抽出時に受信日で補完して誤日付を作る**
  - 該当ファイル: [llm-parser.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-parser.ts:188)
  - 問題: `r.workDate ?? received_at の日付` を採用しています。
  - 影響: 「明日の案件」で抽出失敗した場合、配車日が受信日にずれます。照合では別日に `dispatch_only/client_only` が出ます。
  - 推奨対応: `workDate` 欠落は自動補完せず review 扱いにするか、補完したことを明示 warning と confidence downgrade に反映してください。

- **[MEDIUM] 日付・時刻バリデーションが正規表現止まりで不正値を通す**
  - 該当ファイル: [llm-client.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-client.ts:232), [reconciliation.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation.ts:251)
  - 問題: `2026-99-99`, `99:99`, `2026-02-31` 相当を論理日付として検証していません。
  - 影響: 月末・月境界の照合で silent mismatch になります。`invalid work_day for period` warning も 2 月 31 日では出ません。
  - 推奨対応: calendar-valid date/time 判定に置き換えてください。

- **[MEDIUM] prompt caching 時の token usage と cost 集計が過小になる**
  - 該当ファイル: [llm-client.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-client.ts:100), [llm-parse-results.ts](/home/user/steelo-invoice/packages/db/src/llm-parse-results.ts:110)
  - 問題: `usage.input_tokens` しか保存しておらず、`cache_creation_input_tokens` / `cache_read_input_tokens` を捨てています。
  - 影響: cache 有効時に実処理 token と課金把握がずれ、月次統計・コスト見積が信用しにくくなります。
  - 推奨対応: cache write/read token 列を保存し、モデル別単価で計算してください。Anthropic は total input を `cache_read + cache_creation + input` で見ると説明しています。 

- **[MEDIUM] `input_json` が仕様どおりの入力スナップショットになっていない**
  - 該当ファイル: [llm-parser.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-parser.ts:171)
  - 問題: 保存しているのは `text.slice(0, 4000)` だけで、system prompt、user prompt、receivedAt、driver hint、prompt bundle の完全再現情報がありません。
  - 影響: 後から「この出力をどう作ったか」を再現できず、Phase 3 の後方互換再解析・監査・bench 比較が弱くなります。
  - 推奨対応: PII 最小化方針を決めた上で、少なくとも `promptVersion`, `receivedAt`, `driverHintUsed`, `messageTextSnapshot`, `systemPromptHash` を保存してください。

- **[MEDIUM] LLM stats の `to` 日付が当日分を落とす**
  - 該当ファイル: [llm-parse-results.ts](/home/user/steelo-invoice/packages/db/src/llm-parse-results.ts:119), [llm-stats/page.tsx](/home/user/steelo-invoice/apps/web/src/app/llm-stats/page.tsx:52)
  - 問題: UI は `type=date` の `YYYY-MM-DD` を渡し、SQL は `created_at <= ?` で比較しています。
  - 影響: `to=2026-05-21` なら `2026-05-21T...` が文字列比較で除外されます。Phase 1 で警戒した time 比較バグ系です。
  - 推奨対応: `to` は翌日 exclusive (`created_at < nextDayStart`) にしてください。

- **[MEDIUM] warnings 実装が仕様の検出ルールと一致していない**
  - 該当ファイル: [reconciliation.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation.ts:275)
  - 問題: 仕様は「dispatch 側メモがあるのに client advance_payment=0」等を挙げていますが、実装は `advance_payment > 0 && unmatched` を warning にしています。さらに `DispatchLike` に notes 相当がありません。
  - 影響: UI に出る warning が業務上見たい異常とずれます。
  - 推奨対応: warnings 要件を Phase 2 で本当に出すか Phase 3 に送るか決め、出すなら入力モデルに必要フィールドを追加してください。

- **[MEDIUM] Phase 2 の品質ゲートが仕様に届いていない**
  - 該当ファイル: [steelo-bench.yml](/home/user/steelo-invoice/.github/workflows/steelo-bench.yml:50), [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase2-reconciliation/tasks.md:186)
  - 問題: workflow に Phase 2 unit/integration は入っていますが、`llm-golden` fixture、F1/field accuracy bench、reconciliation 1,000 件性能 bench、route preflight/retry/manual-match/reparse の失敗系テストが見当たりません。
  - 影響: 今回の retired model、cache token 集計、reparse 重複、archive 部分失敗を CI が止められません。
  - 推奨対応: golden gate と失敗系 integration を Phase 2 の merge gate に入れてください。

---

### 補足確認

- STEELO CORS の Phase 2 プレフィックス追加は確認できました: [steelo-cors.ts](/home/user/steelo-invoice/apps/worker/src/middleware/steelo-cors.ts:22)
- 共通 Bearer 認証配下に Phase 2 route が mount されていることも確認できました: [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:153), [auth.ts](/home/user/steelo-invoice/apps/worker/src/middleware/auth.ts:57)
- `ANTHROPIC_API_KEY` が直接 audit payload や log payload に入る箇所は今回の対象範囲では見つけていません。

### 検証

対象テスト実行を試しましたが、read-only filesystem のため Vitest が `vitest.config.ts.timestamp-...mjs` を書けず起動できませんでした。  
確認できた既存テストは [phase2-integration.test.ts](/home/user/steelo-invoice/apps/worker/src/phase2-integration.test.ts:1), [reconciliation.test.ts](/home/user/steelo-invoice/apps/worker/src/services/reconciliation.test.ts:1), [llm-client.test.ts](/home/user/steelo-invoice/apps/worker/src/services/llm-client.test.ts:1) です。

**次のタスクはこれ**:  
1. `claude-3-haiku-20240307` 移行  
2. LLM parse と reconciliation の確定処理を idempotent + atomic に直す  
3. Queue の DLQ / retry / recovery と reparse 重複防止を固める  
4. その後に golden/bench/失敗系 integration を足して Phase 2 の再レビューに進む。