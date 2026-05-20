# Implementation Plan — Phase 1 MVP

本実装計画は `.kiro/specs/phase1-mvp/requirements.md`（10要件）と
`.kiro/specs/phase1-mvp/design.md`（Codex レビュー反映済み）に基づく。
タスクは Foundation → Core → Integration → Validation の順で配置し、
core 層では非依存タスクに `(P)` マーカーを付与する。

## 進捗（全タスク完了）

- **完了**: 43 / 43 サブタスク。バックエンド + Web UI + 統合テスト + ベンチ + 運用 doc を網羅
- **テスト**: STEELO 関連 73 件グリーン（worker 46 + db 27）、typecheck 全パッケージパス、
  Next.js build もエラーなく完了
- **ベンチ**: 200 行 1 ヶ月分の xlsx 生成 11.2ms / +4.30MB（目標 2s / 16MB を大きくクリア）

ready_for_implementation 段階は完了。次は本番デプロイの事前準備
（`docs/operations/cloudflare-access.md` の手順、`docs/operations/phase1-acceptance.md`
の手動チェック）に進む。

---

## 1. Foundation: 環境・バインディング・共通基盤の整備

- [x] 1.1 D1 マイグレーション `046_steelo_phase1.sql` を作成し schema.sql に同期する
  - 11テーブル（drivers, driver_aliases, line_messages, dispatch_records, import_previews, import_batches, client_records, driver_deductions, driver_payment_summaries, payment_summary_lines, payment_jobs, audit_logs）の `CREATE TABLE IF NOT EXISTS` を1ファイルに記述する
  - UNIQUE 制約（line_messages.message_id、driver_aliases.alias_name、(driver_id, period) 系、generated column 経由の period_confirmed_key / active_period_key）を含める
  - 必要な複合インデックスを付与する
  - 観測可能完了条件: `pnpm db:migrate:local` がエラーなく完走し、ローカル D1 に全テーブルが存在する
  - _Requirements: 7.1, 7.4, 7.5, 7.6_

- [x] 1.2 Cloudflare バインディングを wrangler.toml に追加する
  - R2 バケット `STEELO_FILES`（preview/, generated/{period}/ プレフィックス）をバインド
  - Queues `payment-job-queue`（producer + consumer 両方）をバインド。Queues 利用不可なら `payment_jobs` テーブル + Scheduled cron `*/5 * * * *` で代替する旨を README に注記
  - 環境変数 `STEELO_WEB_ORIGINS` のシークレット登録を `wrangler secret put` で行う運用手順を README に追記
  - 観測可能完了条件: `wrangler dev` 起動時に R2/Queues バインディングが警告なくロードされる
  - _Requirements: 5.7, 5.8, 6.3, 7.3_

- [x] 1.3 共有型を `@line-crm/shared` に追加する
  - Driver, DriverAlias, DriverDeduction, LineMessage, DispatchRecord, ClientRecord, ImportBatch, ImportPreview, DriverPaymentSummary, PaymentSummaryLine, PaymentJob, AuditLog の camelCase 型を全て定義
  - PaymentInput / PaymentResult（payment-calculator 用、deductions と rates を入力に持つ）を定義
  - 観測可能完了条件: Worker / Web 双方から型インポートできて `pnpm typecheck` がパスする
  - _Requirements: 7.5, 5.2, 9.1, 10.1_

- [x] 1.4 STEELO 専用の origin 限定 CORS ミドルウェアを実装する
  - 環境変数 `STEELO_WEB_ORIGINS`（カンマ区切り）をパースし、許可リスト方式で `Access-Control-Allow-Origin` を返す
  - preflight `OPTIONS` を Bearer 必須から除外しつつ、未許可 origin は 403 で拒否する
  - `app.use('/api/(drivers|driver-aliases|driver-deductions|excel-imports|payment-summaries|audit-logs)*', steeloCors)` でマウントする
  - 観測可能完了条件: 許可 origin からは応答 + ヘッダ付き、未許可 origin からは 403 を返す手動 curl テストが通る
  - _Requirements: 6.3, 6.4_

- [x] 1.5 監査ログ書き込みヘルパを実装する
  - `recordAudit(db, ctx, { action, resourceType, resourceId, payload })` を提供し、`actor_id`, `actor_name`, `ip`, `user_agent`, `created_at` を埋めて INSERT する
  - 呼び出し側のトランザクションに参加できるよう、ヘルパは外部の `tx` を受け取る形にする
  - 観測可能完了条件: ユニットテストで Hono の `c` モックを渡したときに期待行が D1 に INSERT される
  - _Requirements: 6.8, 10.1, 10.2_

- [x] 1.6 Cloudflare Access ポリシー運用ゲートを README に明文化する
  - STEELO 系エンドポイントと管理画面ホストの Access Application 設定手順、Email OTP / Google を許可する例を記載
  - Access policy 未設定でのデプロイを防ぐ手動チェックリストを `docs/operations/cloudflare-access.md` に追加
  - 観測可能完了条件: 運用手順ドキュメントがリポジトリに存在し、本Specの design.md からリンクされている
  - _Requirements: 6.1, 6.2_

---

## 2. ドライバーマスタ（drivers）

- [x] 2.1 `@line-crm/db` にドライバー CRUD クエリを追加する
  - UUID 採番、`line_group_id` UNIQUE 重複検出、論理削除（is_active=0）、JST timestamp を扱う
  - 観測可能完了条件: vitest で D1 ローカル相手に CRUD 動作と重複拒否が再現する
  - _Boundary: packages/db (drivers)_
  - _Requirements: 2.1, 2.4, 2.5_

- [x] 2.2 ドライバー CRUD ルートを実装する
  - GET / POST / PATCH / DELETE のそれぞれで Zod 風の入力検証、camelCase ↔ snake_case 変換、`recordAudit` を行う
  - DELETE は物理削除せず `is_active=0` + audit `action='driver_archive'`
  - 観測可能完了条件: Hono のテストアダプタで4エンドポイントが期待ステータスを返す
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2.3 ドライバーマスタ画面を実装する
  - 一覧（インボイス有無バッジ、有効/論理削除フィルタ）と編集モーダル
  - `has_invoice` 変更は過去サマリーに遡及しない旨を UI で明示
  - 観測可能完了条件: 開発サーバで20件登録 → 編集 → 削除 → 一覧反映が確認できる
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

---

## 3. ドライバー別名マスタ（driver_aliases）

- [x] 3.1 (P) `driver_aliases` のクエリ関数とルートを実装する
  - 一覧（driver_id 絞り込み）、追加（alias_name UNIQUE 違反は 409）、削除
  - 追加・削除時に `recordAudit(action='driver_alias_create'|'driver_alias_delete')`
  - 観測可能完了条件: alias 追加→重複追加で 409→削除→GET から消える、までが動く
  - _Boundary: routes/driver-aliases.ts, packages/db (driver-aliases)_
  - _Requirements: 8.1, 8.4_

- [x] 3.2 (P) ドライバー名解決ヘルパを実装する
  - `resolveDriverIdByName(db, name)` を提供し、(1) `drivers.name` 完全一致 → (2) `driver_aliases.alias_name` 完全一致 の順で解決
  - どちらにも該当しなければ null を返す
  - 観測可能完了条件: vitest で「マスタ一致」「別名一致」「未紐付け」の3ケースが正しく分岐する
  - _Boundary: services/group-message-handler.ts, services/excel-import.ts（呼び出し側）_
  - _Requirements: 3.9, 8.2_

- [x] 3.3 別名マスタ UI と preview からの 1-click 別名追加を実装する
  - `/driver-aliases` の一覧+追加+削除画面
  - excel-imports の preview 画面の「未紐付け DR 名」リストから既存ドライバーへの別名登録モーダルを開ける
  - 観測可能完了条件: preview 上で別名を追加→再 preview ボタン→未紐付け件数が即時減る
  - _Depends: 3.1, 7.3_
  - _Requirements: 8.3, 8.4_

---

## 4. ドライバー月次控除マスタ（driver_deductions）

- [x] 4.1 (P) `driver_deductions` のクエリ関数を実装する
  - `(driver_id, period)` UNIQUE での UPSERT、period 絞り込み一覧取得、driver+period での single fetch
  - 観測可能完了条件: vitest で UPSERT の挙動（新規 / 更新）と一覧取得が期待値を返す
  - _Boundary: packages/db (driver-deductions)_
  - _Requirements: 9.1_

- [x] 4.2 (P) `driver_deductions` ルートを実装する
  - GET（period / driver_id クエリ）、PUT（UPSERT）、変更時の `recordAudit(action='deduction_update')`
  - 値はすべて非負整数バリデーション
  - 観測可能完了条件: PUT で UPSERT 動作、変更ログが `audit_logs` に残ることが確認できる
  - _Boundary: routes/driver-deductions.ts_
  - _Requirements: 9.2, 9.4, 10.2_

- [x] 4.3 月次控除入力画面を実装する
  - 月選択 + 全ドライバーの控除を1画面で一覧編集（vehicle_cost / processing_fee / prepayment / notes）
  - 行ごとに「保存」または一括保存
  - 観測可能完了条件: 20名分まとめて保存→再読込で値が永続化されている
  - _Depends: 4.2_
  - _Requirements: 9.5_

---

## 5. LINEグループメッセージ受信（F1）

- [x] 5.1 `line_messages` のクエリ関数を実装する
  - INSERT OR IGNORE（message_id UNIQUE による重複拒否を黙過）、一覧（driver/期間/type/limit/offset）、ID 取得
  - 観測可能完了条件: 同 message_id 二度 INSERT で行数が増えないテストが通る
  - _Requirements: 1.7, 4.1, 4.2_

- [x] 5.2 グループメッセージハンドラサービスを実装する
  - LINE Webhook event を受け取り、source.type === 'group' のときに driver 解決＋INSERT OR IGNORE
  - バイナリ系（image/file/video/audio）はメタデータのみ保存
  - 既存の friend/scenario ハンドラを呼ばない
  - 失敗時は `recordAudit(action='webhook_save_failed')`
  - 観測可能完了条件: 4タイプのモック event を投入してそれぞれ正しく保存される
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.8_

- [x] 5.3 webhook.ts にグループ分岐を組み込む
  - 既存 `verifySignature` 後の event ループに `source.type === 'group'` 分岐を追加
  - 200 は同期で即返し、保存処理は `executionCtx.waitUntil` で非同期に実行する
  - 観測可能完了条件: 署名付き group event POST に対し 3 秒以内に 200 が返り、その後 D1 に行が現れる
  - _Depends: 5.2_
  - _Requirements: 1.4, 1.6, 1.8_

- [x] 5.4 LINE メッセージ閲覧画面を実装する
  - 一覧（受信日時降順、フィルタ）と詳細モーダル
  - 観測可能完了条件: 20件以上の蓄積に対しページング・絞り込みが動作する
  - _Requirements: 4.1, 4.2, 4.3_

---

## 6. 配車レコード（dispatch_records、F5の一部）

- [x] 6.1 (P) `dispatch_records` のクエリ関数とルートを実装する
  - 一覧（driver/期間）、新規作成、編集（status='confirmed'）
  - 観測可能完了条件: 新規→編集→一覧表示までが動作する
  - _Boundary: routes/dispatch-records.ts, packages/db (dispatch-records)_
  - _Requirements: 4.4, 4.5, 4.6_

- [x] 6.2 配車レコード一覧・編集画面を実装する
  - 作業日降順 + ドライバー名表示、新規/編集フォーム（元メッセージID任意）
  - 観測可能完了条件: 開発サーバで配車レコードの作成・更新が UI からできる
  - _Depends: 6.1_
  - _Requirements: 4.4, 4.5, 4.6_

---

## 7. Excel インポート（F3）

- [x] 7.1 Excel 検証・パースサービスを実装する
  - `validateXlsx(buffer)` で MIME / サイズ / シート数 / 行数 / 列数 / セル総数 / sharedStrings サイズ / 数式 / 外部リンク / OLE / パスワード保護を多層チェックし、超過時は構造化エラーを返す
  - `parseExcel(buffer)` でヘッダーを**名前ベース動的探索**し、対象月・運賃合計・立替合計・会社合計の車両代/電算/前払・手数料率・税率を抽出する
  - 明細部の同便従属行は `fare=NULL`、空メイン行の備考は直前行に連結
  - 観測可能完了条件: 正常 Excel / 不正 MIME / 過大シート / 数式付き / 同便従属行入りの5パターンが期待結果（成功 or 構造化エラー）を返す
  - _Boundary: services/excel-import.ts_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 7.2 `import_previews` の永続層を実装する
  - preview の R2 への JSON 保存（TTL 1h）、`import_previews` 索引行の INSERT、`expires_at` での scheduled cleanup
  - 観測可能完了条件: preview 作成→1時間経過 or scheduled 実行で R2 オブジェクトと DB 行の双方が消える
  - _Boundary: packages/db (import-previews), services/excel-import.ts_
  - _Requirements: 3.6, 7.1_

- [x] 7.3 Excel インポート preview/confirm ルートを実装する
  - `POST /api/excel-imports/preview`: multipart 受信 → validateXlsx → parseExcel → R2 PUT → `import_previews` INSERT → サマリー＋未紐付け DR 名を返す
  - `POST /api/excel-imports/confirm`: BEGIN → 既存 confirmed があれば `archived` 化（generated column UNIQUE で並行排他）→ `import_batches`(status='confirmed') + `client_records` を bulk INSERT（50行刻み）→ `recordAudit(action='import_confirm'|'import_overwrite')` → COMMIT → R2 preview 削除
  - DR 名解決は 3.2 のヘルパを利用
  - 観測可能完了条件: preview→confirm の正常系、上書きフロー、並行 confirm 時の 409、preview 期限切れ時の 404 が再現できる
  - _Depends: 7.1, 7.2, 3.2_
  - _Requirements: 3.6, 3.7, 3.8, 3.9, 3.10, 10.2_

- [x] 7.4 Excel インポート UI を実装する
  - アップロード → preview 画面（件数/サマリー/警告/未紐付け一覧）→ 確定ボタン → 完了表示
  - 既存 confirmed 検出時の「上書き / キャンセル」モーダル
  - 観測可能完了条件: 実 BOND's Excel 1ヶ月分を用いた手動シナリオで preview→confirm までが UI 経由で完結する
  - _Depends: 7.3_
  - _Requirements: 3.6, 3.7, 3.8_

---

## 8. 支払計算ロジック（純粋関数）

- [x] 8.1 (P) payment-calculator を純粋関数として実装する
  - 入力は `{ driver.hasInvoice, rates.commissionRate, rates.taxRate, deductions, records[] }`、batch ヘッダーの控除は受け取らない
  - 行単位で「手数料控除→税適用→`Math.round()`」してから合算（`rounding_rule='per_line_round'`）
  - `fare=null` の行は `excludedFromCalc=true` で結果に残し、totals には含めない
  - 最終支払額は控除で負になっても返す
  - 観測可能完了条件: ユニットテストでインボイス有/無・fare null・マイナス支払額・税率変更（0.10 と 0.08）・手数料率変更の各境界が期待値を返す（最低6ケース）
  - _Boundary: services/payment-calculator.ts_
  - _Requirements: 5.2, 5.3, 5.4, 5.12, 7.1_

---

## 9. Excel エクスポート（個別 xlsx）

- [x] 9.1 (P) ドライバー別 Excel ビルダーを実装する
  - BOND's フォーマットを土台に、宛名/手数料行/「運賃合計（税込）」化を行う
  - 明細部に当該ドライバーの全行（同便従属行含む）を作業日昇順で描画、運賃列は税込
  - マイナス値は赤字スタイルで表示
  - 観測可能完了条件: 任意の driver+period でビルダーを叩くと正しい .xlsx Buffer が返り、Excel で開いて検算できる
  - _Boundary: services/excel-export.ts_
  - _Requirements: 5.5, 5.6, 5.12_

---

## 10. 支払明細 個別生成 API（同期）

- [x] 10.1 driver_payment_summaries / payment_summary_lines のクエリ関数を実装する
  - `UNIQUE (driver_id, period)` UPSERT、明細スナップショットの INSERT、summary 検索（period / driver_id）
  - 観測可能完了条件: UPSERT で旧スナップショットが正しく置き換わり、明細行も再生成されるテストが通る
  - _Boundary: packages/db (payment-summaries, payment-summary-lines)_
  - _Requirements: 5.10, 5.11_

- [x] 10.2 個別 xlsx 生成 API を実装する
  - `POST /api/payment-summaries/generate { driver_id, period }`: confirmed batch 検索 → `driver_deductions` 取得（不在は 0）→ client_records 取得 → payment-calculator → UPSERT summary（全スナップショット列を埋める）→ summary lines INSERT → `recordAudit('payment_generate')` → buildDriverExcel → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` を返却
  - 並行して r2_xlsx_key にも保存する（再 DL 用）
  - 観測可能完了条件: 1ドライバー1ヶ月分の生成が同期 API で 2秒以内に完了し、Blob DL できる
  - _Depends: 8.1, 9.1, 10.1, 4.1_
  - _Requirements: 5.1, 5.2, 5.3, 5.7, 5.10, 5.11, 10.2_

- [x] 10.3 個別 xlsx 再ダウンロード API を実装する
  - `POST /api/payment-summaries/:summaryId/download-url`: `r2_xlsx_key` が存在すれば 15分の R2 署名付きURL を返す。R2 で消失していれば 410 + 再生成リンク
  - 観測可能完了条件: 既存 summary に対して signed URL を取得し、ブラウザから直接 DL できる
  - _Depends: 10.2_
  - _Requirements: 5.13_

---

## 11. 支払明細 一括生成（非同期ジョブ）

- [x] 11.1 `payment_jobs` のクエリ関数を実装する
  - INSERT（active_period_key UNIQUE で同 period 重複拒否）、status/progress/done_drivers 更新、`r2_zip_key` セット、失敗時の error_message セット
  - 観測可能完了条件: 同 period 二重投入で 409 相当の競合が発生する
  - _Boundary: packages/db (payment-jobs)_
  - _Requirements: 5.9_

- [x] 11.2 ジョブ受付ルートを実装する
  - `POST /api/payment-summaries/jobs { period }`: confirmed batch 検証 → `payment_jobs` 行作成 → Queues に enqueue（or scheduled で取得される pending 行）→ 202 を返す
  - `GET /api/payment-summaries/jobs/:id`: 状態取得
  - 観測可能完了条件: ジョブを投入すると DB に queued 行が現れ、status エンドポイントで参照できる
  - _Depends: 11.1_
  - _Requirements: 5.8, 5.9_

- [x] 11.3 ジョブ実行コンシューマを実装する
  - Queues consumer（or `scheduled()` で `payment_jobs.status='queued'` を拾う実装）として、各 active driver に対し payment-calculator → buildDriverExcel → R2 PUT を順次実行
  - 全件完了後に jszip で `all.zip` を作成し R2 に PUT、`r2_zip_key` を summary 側にも紐付け、status='completed'
  - 例外時は status='failed' + error_message
  - 観測可能完了条件: 20名分の一括ジョブを投入すると 5 分以内に completed になり、R2 に xlsx 群と ZIP が存在する
  - _Depends: 11.2, 8.1, 9.1, 10.1_
  - _Requirements: 5.7, 5.8, 5.10, 5.11_

- [x] 11.4 ZIP 署名付きURL API を実装する
  - `POST /api/payment-summaries/jobs/:id/download-url`: 完了ジョブのみ 15分有効な signed URL を返す
  - 観測可能完了条件: completed ジョブから URL 取得 → ブラウザで R2 から直接 ZIP DL ができる
  - _Depends: 11.3_
  - _Requirements: 5.7, 5.13_

- [x] 11.5 支払明細生成画面を実装する
  - 月選択、個別 DL ボタン（fetch+Blob 方式）、一括ジョブ投入＋ポーリング、完了後の R2 直 DL ボタン
  - `<a href download>` で API を叩かないルールを厳守
  - 観測可能完了条件: 個別 → 同期 DL、一括 → ジョブ完了表示 → 署名付きURLで ZIP DL までを開発サーバで踏破
  - _Depends: 10.2, 10.3, 11.2, 11.4_
  - _Requirements: 5.7, 5.8, 6.4_

---

## 12. 監査ログ閲覧

- [x] 12.1 (P) 監査ログのクエリ関数とルートを実装する
  - actor / action / resource / 期間でのフィルタ、limit/offset ページング、admin ロール限定
  - 観測可能完了条件: GET /api/audit-logs が actor / action でフィルタした行を返す
  - _Boundary: routes/audit-logs.ts, packages/db (audit-logs)_
  - _Requirements: 10.3, 10.4_

- [x] 12.2 (P) 監査ログ閲覧画面を実装する
  - 一覧（時系列、フィルタ）+ payload_json の整形表示
  - 観測可能完了条件: 直近の `import_confirm` / `payment_generate` / `deduction_update` が画面から検索できる
  - _Boundary: apps/web/src/app/audit-logs_
  - _Requirements: 10.3_

---

## 13. 統合: ルートマウントとナビゲーション

- [x] 13.1 Worker `index.ts` に新規ルートをマウントし、Queues consumer を登録する
  - drivers, driver-aliases, driver-deductions, line-messages, dispatch-records, excel-imports, payment-summaries, payment-jobs, audit-logs を `/api/...` にマウント
  - STEELO CORS ミドルウェアを対象パスに適用
  - Queues バインディングがあれば `queue()` ハンドラを登録、無ければ `scheduled()` で payment-jobs を消化
  - 観測可能完了条件: `wrangler dev` 起動時に全エンドポイントが Hono のルートテーブルに現れ、CORS ミドルウェアが適用されていることが確認できる
  - _Depends: 1.4, 2.2, 3.1, 4.2, 5.1, 6.1, 7.3, 10.2, 10.3, 11.2, 11.4, 12.1_
  - _Requirements: 6.3, 6.5, 6.6, 5.8_

- [x] 13.2 `app-shell.tsx` のナビゲーション項目を追加する
  - 「ドライバー」「ドライバー別名」「月次控除」「LINEメッセージ」「配車レコード」「Excelインポート」「支払明細生成」「監査ログ」
  - 既存 LINE Harness のメニューは無変更で共存させる
  - 観測可能完了条件: 既存メニューが消えず、新規8項目から各ページに遷移できる
  - _Requirements: 6.5, 6.6_

- [x] 13.3 Web `lib/api.ts` に新規エンドポイントの呼び出し関数を追加する
  - Bearer 自動付与、fetch+Blob ヘルパ（個別 xlsx DL 用）、polling ヘルパ（payment-jobs 進捗用）
  - 観測可能完了条件: 各 UI が `<a download>` を使わずに DL できる
  - _Requirements: 6.4_

---

## 14. Validation: テスト・ベンチ・手動シナリオ

- [x] 14.1 統合テスト（Worker 側）を追加する
  - LINE group webhook → line_messages 保存 → 再送で行が増えない
  - Excel preview → confirm → 上書き → 409 のシナリオ
  - 個別支払明細生成 → スナップショット保存 → 再 DL（R2 hit）
  - 一括ジョブ投入 → completed → 署名付きURL → R2 GET
  - 観測可能完了条件: `pnpm -F worker test` が緑になる
  - _Requirements: 1.7, 3.7, 3.8, 5.10, 5.13, 7.7_

- [x] 14.2 Excel エクスポートのベンチマークゲートを設置する
  - `services/excel-export.bench.ts` をvitest bench で実装し、1ドライバー1ヶ月分（200 行想定）の生成時間とメモリを計測
  - 目標: 2 秒以内 / 16 MB 以内。閾値超過時は bench が失敗するアサーションを入れる
  - CI（`.github/workflows/`）でも実行されるよう pnpm script を追加
  - 観測可能完了条件: bench を実行して目標値内に収まること、上限を意図的に超えるテストデータで bench が失敗することの両方が確認できる
  - _Depends: 9.1_
  - _Requirements: 7.3_

- [x] 14.3 手動受入チェックリストを `docs/operations/phase1-acceptance.md` に整備する
  - 実 LINE グループ送信 → line_messages 蓄積確認
  - 実 BOND's 過去 Excel を 1〜2ヶ月分 import → 件数・サマリー整合確認
  - 個別・一括 Excel 生成 → 過去支払明細との差分を手計算で検算
  - Cloudflare Access 配下でしかアクセスできないことを確認
  - 観測可能完了条件: チェックリストがリポジトリに存在し、design.md からリンクされている
  - _Requirements: 6.1, 6.7, 7.7_

---

## カバレッジ確認

- Requirement 1（LINE受信、1.1-1.8）: tasks 5.1-5.4, 13.1, 14.1
- Requirement 2（ドライバーマスタ、2.1-2.5）: tasks 2.1-2.3
- Requirement 3（Excel取込、3.1-3.10）: tasks 7.1-7.4, 3.2
- Requirement 4（メッセージ・配車閲覧、4.1-4.6）: tasks 5.1, 5.4, 6.1-6.2
- Requirement 5（支払明細生成、5.1-5.13）: tasks 8.1, 9.1, 10.1-10.3, 11.1-11.5
- Requirement 6（認証・UI・監査、6.1-6.8）: tasks 1.4, 1.6, 13.1-13.3, 12.x, 14.3
- Requirement 7（非機能、7.1-7.7）: tasks 1.1, 1.3, 7.2, 8.1, 10.1, 14.1-14.2
- Requirement 8（driver_aliases、8.1-8.4）: tasks 3.1-3.3
- Requirement 9（driver_deductions、9.1-9.5）: tasks 4.1-4.3
- Requirement 10（audit_logs、10.1-10.4）: tasks 1.5, 4.2, 7.3, 10.2, 12.1-12.2, 14.1

全ての要件 ID が少なくとも 1 タスクに対応していることを確認済み。
