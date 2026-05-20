### サマリー
19件のうち、主要な CRITICAL/HIGH はかなり反映されています。特に Workers 互換、`line-messages` ルート追加、CORS 順序、import confirm の confirmed 欠損回避は改善されています。  
ただし、ジョブ復旧の時刻比較と一括 ZIP の R2 消失時復旧に、まだ運用で詰まる問題があります。

今の進捗を全体像から整理するとこれ: 「個別明細の生成・再構築」はかなり固まりましたが、「一括ジョブを長期運用で確実に復旧できるか」の層に残課題があります。  
次のタスクはこれ: まず `recoverStuckPaymentJobs` の時刻比較を epoch 比較に直し、次に ZIP ダウンロードを snapshot から再構築できるようにしてください。

### 残課題

- **[HIGH] running ジョブ復旧の時刻比較が文字列比較で、30分復旧が実際には効きにくい**
  - 該当ファイル: [payment-summaries.ts](/home/user/steelo-invoice/packages/db/src/payment-summaries.ts:340)
  - 問題: `started_at < cutoff` を文字列で比較しています。`started_at` は `+09:00` 形式、`cutoff` は `Z` 形式なので、同じ時刻軸として正しく比較できません。
  - 影響: 30分で failed に倒すつもりでも、実運用では数時間以上 `running` が残り、同 period の再投入が 409 のまま詰まる可能性があります。
  - 推奨対応: SQL 文字列比較ではなく、取得後に `new Date(started_at).getTime()` で epoch 比較するか、保存形式を UTC ISO に統一してください。

- **[HIGH] 一括 ZIP は R2 消失時に snapshot から再構築できない**
  - 該当ファイル: [payment-jobs.ts](/home/user/steelo-invoice/apps/worker/src/routes/payment-jobs.ts:112)
  - 問題: 個別 xlsx の download は `payment_summary_lines` から再構築できますが、`/api/payment-summaries/jobs/:id/download` は R2 の ZIP が無いと 410 のままです。
  - 影響: 一括生成結果の ZIP が R2 から消えると、過去の支払明細をまとめて再取得できません。
  - 推奨対応: `payment_job_id = job.id` の summaries と lines から各 xlsx を再構築し、その場で ZIP を再生成する fallback を追加してください。

- **[MEDIUM] invalid workDay がエラーではなく warning + 行スキップになっている**
  - 該当ファイル: [excel-import.ts](/home/user/steelo-invoice/apps/worker/src/services/excel-import.ts:463)
  - 問題: 前回は `workDay` 不正を行エラーにする趣旨でしたが、現状は warning にしてその行を捨てます。
  - 影響: Excel に `"32日"` や壊れた日付があると、プレビューは通るが明細行が silently drop され、支払額が欠ける可能性があります。
  - 推奨対応: 不正 `workDay` は `ExcelValidationError` または preview の blocking error として confirm 不能にしてください。

- **[MEDIUM] driver update で空白 name を保存できる**
  - 該当ファイル: [drivers.ts](/home/user/steelo-invoice/apps/worker/src/routes/drivers.ts:96)
  - 問題: create では `name.trim() !== ''` を見ていますが、patch は `typeof body.name === 'string'` だけで `updateDriver` に渡しています。
  - 影響: ドライバーマスタ名が空白になり、Excel の DR 名解決や表示が壊れます。
  - 推奨対応: patch でも create と同じく `trim()` 後の非空チェックを行い、保存値も trim 済みにしてください。

- **[LOW] 追加された line-messages ルートの limit/offset が NaN を通す**
  - 該当ファイル: [line-messages.ts](/home/user/steelo-invoice/apps/worker/src/routes/line-messages.ts:39)
  - 問題: `Number(limitRaw)` が `NaN` でもそのまま DB 層に渡ります。
  - 影響: 不正クエリで 500 になる可能性があります。
  - 推奨対応: 既存の `clampLimit` / `clampOffset` を使って 400 または安全な既定値にしてください。

### テスト確認
`pnpm --filter worker typecheck` は成功しました。  
対象テストは Vitest が read-only filesystem 上で一時 config を作れず、`EROFS` で起動前に失敗しました。コード由来のテスト失敗ではありませんが、今回の環境では実行完了確認はできていません。