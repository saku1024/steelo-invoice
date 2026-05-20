### サマリー
全体として、支払計算の純粋関数・スナップショット用テーブル・generated column による排他など、設計レビュー後の主要な方向修正はかなり反映されています。  
ただし、実運用で止まる可能性がある箇所がまだ残っています。特に **Worker runtime 非互換、インポート確定の非原子性、LINE メッセージ閲覧 API 未実装、CORS/Access の保護漏れ** は Phase 1 MVP の成立に直結します。

今の進捗を全体像から整理するとこれ: DB と計算の土台はかなりできていますが、「画面から実際に安全に使える API として結線されているか」「失敗時にデータが壊れないか」の層に重大な穴があります。  
次のタスクはこれ: まず CRITICAL/HIGH のうち、`line-messages` ルート追加、Excel 出力の Workers 互換化、import confirm のトランザクション相当化、STEELO ルートの CORS/Access 保護を先に直してください。

### 指摘事項（優先度順）

- **[CRITICAL] Excel 生成コードが Cloudflare Workers runtime で動かない可能性が高い**
  - 該当ファイル: [excel-export.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-export.ts:131), [payment-batch-job.ts](/home/user/steelo-invoice/apps/worker/src/services/payment-batch-job.ts:9), [wrangler.toml](/home/user/steelo-invoice/apps/worker/wrangler.toml:3)
  - 問題: `XLSX.write(..., { type: 'buffer' }) as Buffer` と `node:zlib` import を使っていますが、`wrangler.toml` に `nodejs_compat` がありません。
  - 影響: ローカル typecheck は通っても、Workers 本番で `Buffer` / Node builtin が使えず Excel 生成やデプロイが失敗する可能性があります。
  - 推奨対応: `type: 'array'` に変更し、`node:zlib` import は削除してください。
    ```ts
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return new Uint8Array(bytes);
    ```

- **[CRITICAL] インポート確定が原子的ではなく、失敗時に confirmed バッチだけ残る**
  - 該当ファイル: [import-batches.ts](/home/user/steelo-invoice/packages/db/src/import-batches.ts:235), [import-batches.ts](/home/user/steelo-invoice/packages/db/src/import-batches.ts:291)
  - 問題: `import_batches` を `confirmed` で INSERT した後に `client_records` を別処理で INSERT しています。途中で `insertClientRecords` が失敗すると、明細行が一部またはゼロの confirmed バッチが残ります。
  - 影響: 支払明細生成が欠損データを正として扱い、支払額が過少になります。
  - 推奨対応: D1 `db.batch()` に batch INSERT と client_records INSERT と audit INSERT をまとめる、または最初は `pending` で作成し、全行投入後に最後の UPDATE で `confirmed` にしてください。

- **[CRITICAL] 上書きインポート時、旧 confirmed を先に archived にするため復旧不能状態が起きる**
  - 該当ファイル: [import-batches.ts](/home/user/steelo-invoice/packages/db/src/import-batches.ts:245)
  - 問題: `overwrite=true` で旧バッチを `archived` にしてから新バッチを INSERT します。新規 INSERT や明細 INSERT が失敗すると、その period に有効な confirmed がなくなります。
  - 影響: 月次支払生成が突然 `no confirmed batch` になり、旧データにも戻れません。
  - 推奨対応: 新バッチを `pending` で作る → 明細投入 → 旧 confirmed を archived → 新バッチ confirmed、の順を単一 batch/補償付きで実行してください。

- **[CRITICAL] `/api/line-messages` ルートが存在せず、LINE メッセージ閲覧画面が動かない**
  - 該当ファイル: [api.ts](/home/user/steelo-invoice/apps/web/src/lib/api.ts:1721), [line-messages/page.tsx](/home/user/steelo-invoice/apps/web/src/app/line-messages/page.tsx:33), [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:194)
  - 問題: Web は `/api/line-messages` を呼びますが、`apps/worker/src/routes/line-messages.ts` がありません。`index.ts` にもマウントされていません。
  - 影響: 要件 F5 の LINE メッセージ閲覧が 404 で使えません。
  - 推奨対応: `listLineMessages` / `getLineMessageById` を使う Worker route を追加し、`index.ts` と `steeloCors` 対象にも `/api/line-messages*` を追加してください。

- **[HIGH] STEELO CORS の前に全 origin 許可 CORS が適用されている**
  - 該当ファイル: [index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:125), [steelo-cors.ts](/home/user/steelo-invoice/apps/worker/src/middleware/steelo-cors.ts:16)
  - 問題: `app.use('*', cors({ origin: '*' }))` が先に走ります。特に preflight はグローバル CORS 側で処理され、STEELO 専用 origin 制限に到達しない可能性があります。
  - 影響: STEELO 系 API の origin 限定という防御層が仕様通り効きません。
  - 推奨対応: STEELO パスを先に `steeloCors()` へ通す、またはグローバル CORS 側で STEELO パスを除外してください。

- **[HIGH] Cloudflare Access 必須の前提を Worker 設定が弱めている**
  - 該当ファイル: [wrangler.toml](/home/user/steelo-invoice/apps/worker/wrangler.toml:4), [auth.ts](/home/user/steelo-invoice/apps/worker/src/middleware/auth.ts:57)
  - 問題: `workers_dev = true` のままだと、Access Application を設定した独自ホストとは別に workers.dev 経由で到達できる可能性があります。コード側も Access JWT は検証せず Bearer のみです。
  - 影響: 要件の「Cloudflare Access + Bearer の二段認証」ではなく、経路によって Bearer 単独になります。
  - 推奨対応: 本番では `workers_dev = false` を明示し、可能なら STEELO API で `Cf-Access-Jwt-Assertion` の存在または検証を追加してください。

- **[HIGH] R2 消失時の 410 後、保存済みスナップショットから再生成できない**
  - 該当ファイル: [payment-summaries.ts](/home/user/steelo-invoice/apps/worker/src/routes/payment-summaries.ts:123), [payment-summaries.ts](/home/user/steelo-invoice/apps/worker/src/routes/payment-summaries.ts:164)
  - 問題: download で R2 missing 時に 410 は返しますが、再生成手段は `POST /generate` だけです。この処理は現在の driver/import/deduction から再計算します。
  - 影響: 過去明細の R2 が消えた場合、当時のスナップショットではなく現在データで上書き再生成され、監査性が壊れます。
  - 推奨対応: `payment_summary_lines` と `driver_payment_summaries` から Excel を再構築する専用 API を追加してください。

- **[HIGH] 一括ジョブが二重実行されうる**
  - 該当ファイル: [payment-batch-job.ts](/home/user/steelo-invoice/apps/worker/src/services/payment-batch-job.ts:143), [payment-summaries.ts](/home/user/steelo-invoice/packages/db/src/payment-summaries.ts:330)
  - 問題: `runPaymentJob` は `SELECT status` 後に無条件で `running` 更新します。複数 invocation が同時に `queued` を読んだ場合、両方が処理に進めます。
  - 影響: サマリー UPSERT、明細行削除/再INSERT、R2 PUT、ZIP 作成が競合し、結果が不安定になります。
  - 推奨対応: `UPDATE payment_jobs SET status='running' ... WHERE id=? AND status='queued'` にして、`changes === 1` の場合だけ処理してください。

- **[HIGH] running ジョブの復旧がなく、失敗すると同 period の再投入が永久に 409 になる**
  - 該当ファイル: [payment-summaries.ts](/home/user/steelo-invoice/packages/db/src/payment-summaries.ts:195), [payment-summaries.ts](/home/user/steelo-invoice/packages/db/src/payment-summaries.ts:316)
  - 問題: active unique key は `queued/running` をロックしますが、scheduled fallback は `queued` しか拾いません。
  - 影響: Worker が `running` 後に落ちると、その period は active job が残り続け、一括生成を再投入できません。
  - 推奨対応: `running` で一定時間 `started_at` が古いジョブを `failed` または `queued` に戻す recovery を cron に入れてください。

- **[HIGH] Excel 検証が仕様ほど実装されていない**
  - 該当ファイル: [excel-import.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-import.ts:100), [excel-import.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-import.ts:121)
  - 問題: sharedStrings サイズ、外部リンク、OLE オブジェクトの検査が実装されていません。また `cellFormula: false` で読むため、数式セルの `cell.f` 検出も信頼できません。
  - 影響: 要件 F3 の DoS/危険 Excel 拒否が抜け、巨大 sharedStrings や外部リンク入りファイルを通す可能性があります。
  - 推奨対応: ZIP エントリを直接検査し、`xl/sharedStrings.xml` サイズ、`xl/externalLinks/*`、`embeddings/*`、`oleObjects/*` を拒否してください。数式検出は `cellFormula: true` で読む必要があります。

- **[MEDIUM] import_confirm / import_overwrite の audit が同一トランザクションではない**
  - 該当ファイル: [excel-imports.ts](/home/user/steelo-invoice/apps/worker/src/routes/excel-imports.ts:240)
  - 問題: confirm 後に route 層で audit を別 INSERT しています。
  - 影響: audit INSERT だけ失敗すると、重要操作は実行済みなのに監査ログが残りません。
  - 推奨対応: `confirmImportBatch` に audit entry も渡し、DB batch 内で同時に書いてください。

- **[MEDIUM] 支払明細のマイナス額が「赤字表示」ではなく文字列化される**
  - 該当ファイル: [excel-export.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-export.ts:102)
  - 問題: SheetJS OSS の制約回避として `▲ 1,000` の文字列に変換しています。
  - 影響: Excel 上で数値として集計できず、仕様の「マイナスをそのまま出力」ともずれます。
  - 推奨対応: 値は負の数値のまま保持し、スタイル不可なら別セルに注意文言を出す方が安全です。

- **[MEDIUM] Excel の率パースが 7.5 / "7.5%" に弱い**
  - 該当ファイル: [excel-import.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-import.ts:261)
  - 問題: `commissionRate` / `taxRate` は number の場合だけ採用し、文字列は既定値になります。さらに Excel 側が `7.5` と入っていると `7.5` のまま保存され、計算時に range error になります。
  - 影響: Excel の入力形式によって preview は通っても支払生成が 500 になります。
  - 推奨対応: `7.5%`、`7.5`、`0.075` を正規化する `parseRate` を用意してください。

- **[MEDIUM] Excel 対象月が日本語表記だと読めない**
  - 該当ファイル: [excel-import.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-import.ts:227)
  - 問題: period regex が `YYYY-MM` / `YYYY/MM` のみです。
  - 影響: `2026年5月` のような日本語 Excel ヘッダーで 422 になります。
  - 推奨対応: `/(\d{4})年\s*(\d{1,2})月/` も受けて `YYYY-MM` に正規化してください。

- **[MEDIUM] 明細行の `workDay` が NaN になりうる**
  - 該当ファイル: [excel-import.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-import.ts:381)
  - 問題: `Number(workDayCell ?? 0)` で変換しています。`"1日"` や空日付 + 業務名ありの行は `NaN` になります。
  - 影響: D1 に不正値が入り、並び順や支払明細の表示が壊れます。
  - 推奨対応: `parseWorkDay` を作り、1〜31 以外は warning ではなく行エラーにしてください。

- **[MEDIUM] CRUD の runtime 入力検証が不足している**
  - 該当ファイル: [drivers.ts](/home/user/steelo-invoice/apps/worker/src/routes/drivers.ts:91), [driver-aliases.ts](/home/user/steelo-invoice/apps/worker/src/routes/driver-aliases.ts:38), [dispatch-records.ts](/home/user/steelo-invoice/apps/worker/src/routes/dispatch-records.ts:54)
  - 問題: TypeScript 型に寄せていますが、実際の JSON は runtime では任意です。`hasInvoice: "false"` が truthy 扱い、空白 alias が登録可能、dispatch の数値/時刻/driver 存在チェック不足などがあります。
  - 影響: 管理画面や外部呼び出しから壊れたマスタ・配車データが保存されます。
  - 推奨対応: zod 等、または手書き validator で型・長さ・形式・存在チェックを route 入り口で統一してください。

- **[MEDIUM] 配車レコード作成・更新の audit_logs がない**
  - 該当ファイル: [dispatch-records.ts](/home/user/steelo-invoice/apps/worker/src/routes/dispatch-records.ts:52), [dispatch-records.ts](/home/user/steelo-invoice/apps/worker/src/routes/dispatch-records.ts:78)
  - 問題: 手動 CRUD のうち、dispatch_records は create/update しても audit を残していません。
  - 影響: 手入力・修正が支払や照合準備に影響しても、誰が直したか追えません。
  - 推奨対応: `dispatch_create` / `dispatch_update` を AuditAction に追加し、before/after 差分を保存してください。

- **[LOW] preview の R2 フォールバックが D1 に大きな JSON を詰める**
  - 該当ファイル: [excel-imports.ts](/home/user/steelo-invoice/apps/worker/src/routes/excel-imports.ts:151)
  - 問題: `STEELO_FILES` 未バインド時、最大 5,000 行の preview 本体を `summary_json` に埋め込みます。
  - 影響: D1 行サイズ肥大、レスポンス遅延、preview confirm の 500 が起きやすくなります。
  - 推奨対応: Phase 1 では `STEELO_FILES` を必須にして、未バインドなら preview を 500 で拒否する方が安全です。