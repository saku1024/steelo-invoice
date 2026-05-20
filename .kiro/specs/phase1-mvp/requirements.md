# Requirements Document

## Introduction

STEELO 稼働照合・ドライバー支払明細システムの Phase 1 MVP の要件を定義する。
本Phaseでは「LINEから配車メッセージを蓄積し、元請けExcelを取り込み、
管理画面で確認した上で、ドライバー別支払明細Excelを生成する」までの一連の
基本フローを成立させることを目的とする。

ベースは LINE Harness OSS の Cloudflare Workers + D1 + Next.js 15 構成。
プロジェクトルートの `requirements.md` を上位仕様とし、本ドキュメントは
Phase 1 のスコープに限定した詳細要件である。

## Boundary Context

- **In scope**:
  - F1: LINEメッセージ受信・蓄積（配車メッセージ・完了報告を全件保存）
  - F3: 元請けBOND's支払明細Excelのアップロード・パース・取り込み
  - F5: 管理画面の基本CRUD（ドライバーマスタ、LINEメッセージ閲覧、
    Excelインポート操作、配車レコード手動編集）
  - F6: ドライバー支払明細Excelの計算・出力（個別・ZIP一括）
- **Out of scope**:
  - F2: Claude Haiku によるメッセージ自動解析（Phase 2）
  - F4: 自動照合エンジン（Phase 2）
  - F5の照合結果画面・差分レポート（Phase 2）
  - 配車メッセージの構造化は Phase 1 では手動入力 or 後続Phaseで自動化
- **Adjacent expectations**:
  - 既存LINE Harnessの友だち管理・シナリオ配信・broadcast機能はそのまま保持し、
    本機能と共存する
  - 既存の `webhook.ts` 受信フローは継続稼働、新たに「グループメッセージ」
    向け処理を追加する
  - 認証は既存LINE Harnessの APIキー基盤を流用しつつ、**Cloudflare Access を
    必須化**する（STEELO エンドポイント全体を Access Application 配下に置く）
  - **Phase 1 のプロダクト価値は「支払明細生成の半自動化」**である。
    LINE配車レコードと元請けExcelの自動照合（F4）は Phase 2 で実装するため、
    Phase 1 完了時点では「自動照合」は成立しない点を関係者と合意する

## Requirements

### Requirement 1: LINEグループメッセージ受信・蓄積（F1）

**Objective:** 管理者として、ドライバー別LINEグループに流れる配車メッセージ・
完了報告・画像等を全件Webhookで自動蓄積し、後続の照合・確認に使えるようにしたい。
これにより配車記録の手動転記をゼロにし、欠落を防止する。

#### Acceptance Criteria

1. When LINE Platform から `message` イベントが Webhook で送信された場合、
   the system shall ペイロードのソース種別（user / group / room）を判定し、
   group の場合は `line_messages` テーブルに `group_id`, `sender_user_id`,
   `sender_name`, `message_text`, `message_type`, `message_id`, `received_at` を保存する。
2. When 受信したグループの `group_id` が `drivers.line_group_id` に登録済みの場合、
   the system shall 当該ドライバーの `driver_id` を `line_messages.driver_id` に
   紐付けて保存する。未登録グループは `driver_id = NULL` で保存する。
3. When メッセージのtypeが `image` / `file` / `video` / `audio` の場合、
   the system shall メタデータ（message_type と LINE message_id）のみを保存し、
   バイナリ実体は Phase 1 ではダウンロードしない。
4. The system shall LINE 署名検証（`X-Line-Signature` の HMAC-SHA256）を必須とし、
   検証失敗時は 200 を返しつつ DB には書き込まない（既存LINE Harnessと同等）。
5. The system shall グループメッセージ受信時、既存の friend/scenario 関連処理
   （`upsertFriend`、`enrollFriendInScenario` 等）は実行しない（個別チャットと
   グループは別フロー）。
6. While Webhook応答性能要件として、the system shall 受信から **200 OK 返却**までを
   3秒以内に完了し、D1 書き込みは `executionCtx.waitUntil` で非同期に完了する。
   （200 返却と保存完了は分離して定義する。LINEの 1分タイムアウト制約内）
7. The system shall `line_messages.message_id` に UNIQUE 制約を設定し、LINE Webhook
   の再送による重複保存を防ぐ。重複時は INSERT OR IGNORE 相当で黙過する。
8. When 非同期保存が失敗した場合、the system shall `console.error` で詳細を出力し、
   `audit_logs` に `action='webhook_save_failed'` で記録する（再処理は行わない）。

### Requirement 2: ドライバーマスタ管理（F5の一部）

**Objective:** 管理者として、ドライバー20名分の基本情報（氏名、LINEグループID、
インボイス有無等）を管理画面でCRUD操作したい。これがないと支払計算と
LINE紐付けが成立しない。

#### Acceptance Criteria

1. When 管理者が「ドライバー追加」を実行した場合、the system shall `name`,
   `name_kana`, `line_group_id`, `line_group_name`, `has_invoice`, `is_active`,
   `notes` を入力可能なフォームを提供し、保存時にUUIDを採番して `drivers` テーブルに
   挿入する。
2. The system shall ドライバー一覧画面で全ドライバーを表示し、各行に氏名・
   LINEグループ名・インボイス有無バッジ・有効フラグを表示する。
3. When 管理者がドライバーを編集して `has_invoice` を変更した場合、
   the system shall 当該変更を保存し、その後に生成される支払明細にのみ反映する
   （過去の生成済み明細には遡らない）。
4. When 管理者がドライバーを削除しようとした場合、the system shall 物理削除では
   なく `is_active = 0` への論理削除を行い、関連する `line_messages` /
   `dispatch_records` / `client_records` のFKは維持する。
5. The system shall `line_group_id` のユニーク制約を持ち、重複登録を拒否する
   （1ドライバー = 1グループの前提）。

### Requirement 3: 元請けExcelインポート（F3）

**Objective:** 管理者として、BOND'sから月次で届く支払明細Excelをアップロードして
取り込み、明細部の各行を `client_records` テーブルに保存したい。これにより
支払明細生成と（Phase 2の）自動照合の元データを揃える。

#### Acceptance Criteria

1. When 管理者がExcelファイル（`.xlsx`）を管理画面からアップロードした場合、
   the system shall まずファイル検証を行い、サイズ（≤10MB）・シート数（≤5）・
   行数（≤5,000/シート）・列数（≤50/シート）・総セル数（≤50,000）・
   sharedStrings サイズ（≤5MB）の上限を超える場合は **422** で早期拒否する。
   数式セル・外部リンク・OLEオブジェクト・パスワード保護は拒否する。
2. The system shall SheetJS でパースし、ヘッダー部からは**ヘッダー名（ラベル文字列）
   をキーに動的に探索**する方式で「対象月（YYYY-MM）」、「運賃合計（税抜）」、
   「立替合計」、「車両代（会社合計）」、「電算処理費（会社合計）」、
   「前払金（会社合計）」、「手数料率（既定 0.075）」、「消費税率（既定 0.10）」を抽出する。
   行番号/列番号の固定参照は最終フォールバックとし、最初に名前ベース探索を試みる。
3. When Excelの明細部を読み取った場合、the system shall 各行から
   日、曜日、業務名、積込み先、納品先、開始時刻、終了時刻、距離km、
   立替金、運賃、DR名、備考を抽出し、preview セッションのメモリ上に保持する
   （`client_records` への書き込みは確定時に限る）。
4. If 運賃列の値が `"-"` または空欄の場合、the system shall `fare = NULL` として
   保存し、エラー扱いとはしない（同便従属行・セット案件の一部として正常）。
5. When 備考列が次行にまたがる場合、the system shall 連続する空のメイン行
   （日・業務名が空）の備考を直前の明細行に連結して保存する。
6. The system shall インポートは2段階で行う。**第1段階（プレビュー）では本番テーブル
   `import_batches` / `client_records` に書き込まない**。`import_previews` に索引
   （preview_id, period, summary, expires_at）と R2 上の JSON 本体への参照のみを保存する。
   既定 TTL は 1 時間。`expires_at` 経過分は Scheduled Worker で物理削除する。
7. When 管理者が「確定」ボタンを押した場合、the system shall preview を読み出し、
   `import_batches` と `client_records` を **同一トランザクション**で原子的に作成する。
   `audit_logs` に `action='import_confirm'` を同トランザクションで記録する。
8. While 同一対象月の confirmed バッチが既に存在する場合、the system shall 警告を
   表示し、「上書き」または「キャンセル」を管理者に選択させる。上書き時は既存バッチを
   `status='archived'` に変更してから新規バッチを confirmed として登録し、
   `audit_logs` に `action='import_overwrite'` を残す。同一 period の confirmed
   重複は **DB の generated column + UNIQUE 制約**でも排他する。
9. The system shall ExcelのDR名を (1) `drivers.name` 完全一致 → (2) `driver_aliases.alias_name`
   完全一致 の順で解決する。両方失敗時は `client_records.driver_id = NULL` で保存し、
   プレビュー画面で未紐付け件数と DR 名一覧を警告表示する。管理者は `driver_aliases`
   を追加して再 preview することでゆれを吸収できる。
10. The system shall **車両代/電算処理費/前払金は import_batches の `header_*` 列に
    BOND's Excel ヘッダーの「会社合計」値として保存する**。これは参照のみであり、
    各ドライバーの支払計算には使わない（控除は `driver_deductions` を参照する。
    Requirement 5 を参照）。

### Requirement 4: LINEメッセージ・配車レコード閲覧（F5の一部）

**Objective:** 管理者として、蓄積されたLINEメッセージと（Phase 1では手動入力の）
配車レコードを管理画面で閲覧・編集したい。これにより照合準備と異常検知を行う。

#### Acceptance Criteria

1. The system shall LINEメッセージ一覧画面で `line_messages` を受信日時降順に
   表示し、ドライバー名・グループ名・送信者名・本文プレビュー（先頭100文字）・
   message_type をリスト表示する。
2. The system shall ドライバー、日付範囲、message_type で絞り込みできる
   フィルタUIを提供する。
3. When 管理者がメッセージをクリックした場合、the system shall 本文全文を
   モーダルまたは詳細画面で表示する。
4. The system shall 配車レコード一覧画面で `dispatch_records` を作業日降順
   ・ドライバー名で表示し、業務名・積込先・納品先・時刻を表示する。
5. When 管理者が配車レコードを「新規作成」した場合、the system shall ドライバー、
   作業日、業務名、積込先、納品先、開始/終了時刻、動態管理番号、元メッセージID
   （任意）を入力できるフォームを提供し、`status='confirmed'` で保存する。
6. When 管理者が配車レコードを編集した場合、the system shall 変更を保存し、
   `status` を `'confirmed'` に更新する。

### Requirement 5: ドライバー支払明細Excel生成（F6）

**Objective:** 管理者として、対象月を指定して全ドライバーまたは個別ドライバーの
支払明細Excelを生成・ダウンロードしたい。これが本システムの最終アウトプットであり、
ドライバーへの支払根拠書類となる。

#### Acceptance Criteria

1. When 管理者が「支払明細生成」画面で対象月（YYYY-MM）を選択した場合、
   the system shall 当該月の confirmed な `import_batch` を1つに特定し、
   存在しなければエラーを返す。
2. The system shall 各ドライバーごとに当該月の `client_records` を集計し、
   以下の計算ロジックで支払額を算出する。計算は純粋関数 `calculatePayment` に
   切り出し、入力は呼び出し側で **生成時点のスナップショット値**を集めて渡す:
   - 控除後運賃（税抜）= `fare` × (1 - `commission_rate_snapshot`)
     （`commission_rate_snapshot` は `import_batches.commission_rate`、既定 0.075）
   - 運賃（税込）= ドライバーの `has_invoice_snapshot = 1` の場合は
     控除後運賃 × (1 + `tax_rate_snapshot`)、それ以外は 控除後運賃のまま
     （`tax_rate_snapshot` は `import_batches.tax_rate`、既定 0.10）
   - **行単位**で 「控除後運賃 → 税込運賃 → `Math.round()` で円単位四捨五入」を行う。
     合算後四捨五入は採用しない（業務合意済みの `rounding_rule = 'per_line_round'`）
   - 立替金（advance_payment）は全額そのまま加算
   - 最終支払額 = 運賃合計（税込・行単位四捨五入済み）+ 立替合計
     − **`driver_deductions.vehicle_cost`** − **`driver_deductions.processing_fee`**
     − **`driver_deductions.prepayment`**
     （`driver_deductions` は per-driver per-period。**`import_batches.header_*` は使わない**）
3. When 当該 driver の `driver_deductions` レコードが存在しない場合、
   the system shall vehicle_cost / processing_fee / prepayment をすべて 0 として計算する。
4. When `fare` が NULL（同便従属行）の行が存在する場合、the system shall 当該行を
   明細には掲載するが運賃計算からは除外する（`payment_summary_lines.excluded_from_calc = 1`
   で記録）。
5. The system shall 元請けExcelのフォーマットをベースに、宛名を「{ドライバー名} 様」、
   「運賃合計」を「運賃合計（税込）」、手数料行を削除（または ¥0 表示）した
   Excelを `xlsx` で生成する。
6. The system shall 明細部に当該ドライバーの全行を作業日昇順で記載し、
   運賃列は計算済みの税込値を表示する。
7. When 管理者が「個別ダウンロード」を選択した場合、the system shall 単一ドライバー
   の `.xlsx` を **同期API**（`POST /api/payment-summaries/generate`）で返す。
   DLは **fetch + Blob** 方式で行い、Authorization ヘッダを送る。
8. When 管理者が「一括ダウンロード」を選択した場合、the system shall **非同期ジョブ**
   として処理する。`POST /api/payment-summaries/jobs` で `payment_jobs` を queued 登録し、
   202 を返す。Queues consumer または Scheduled Worker が各ドライバー分の `.xlsx` を生成し、
   R2 にアップロード後、ZIP 化して `r2_zip_key` を保存。完了後、UIから
   `POST /api/payment-summaries/jobs/:id/download-url` で 15分有効な署名付きURLを取得して
   ブラウザがR2に直接アクセスしてDLする。ZIP内ファイル名は
   `{YYYY-MM}_{ドライバー名}_支払明細.xlsx` 形式。
9. The system shall 同一 period の payment_jobs が `queued` または `running` の間は
   重複投入を **DB の generated column + UNIQUE 制約**で拒否する（409）。
10. The system shall 生成時点のサマリーを `driver_payment_summaries` に
    `UNIQUE (driver_id, period)` で UPSERT し、以下を**スナップショット保存**する:
    `import_batch_id`, `payment_job_id` (任意), `driver_name_snapshot`,
    `has_invoice_snapshot`, `commission_rate_snapshot`, `tax_rate_snapshot`,
    `rounding_rule`, 各種金額, 控除内訳, `r2_xlsx_key`。これにより Excel 上書きや
    マスタ変更があっても当時の明細を再現できる。
11. The system shall 明細行スナップショットを `payment_summary_lines` に保存する
    （fare、fare_after_commission、fare_with_tax、advance_payment、excluded_from_calc）。
12. The system shall 計算結果がマイナス（前払金等の控除で運賃を下回る）の場合も
    そのまま出力し、Excel上に赤字表示で注意喚起する。
13. The system shall 過去に生成済みの `driver_payment_summaries` について、
    R2 オブジェクトが存在する間は **再ダウンロード**を提供する
    （`GET /api/payment-summaries/:summaryId/download-url`）。R2 で消失している場合
    （410）は、保存済みスナップショットから**再生成**する手段を提供する。

### Requirement 6: 管理画面の認証・基本UI（F5の基盤）

**Objective:** 管理者として、PII および支払情報を扱うため、Cloudflare Access による
人認証配下で安全に本機能を操作したい。

#### Acceptance Criteria

1. The system shall STEELO 系の全エンドポイント（`/api/drivers*`, `/api/driver-aliases*`,
   `/api/driver-deductions*`, `/api/excel-imports*`, `/api/payment-summaries*`,
   `/api/payment-summaries/jobs*`, `/api/audit-logs`, および管理画面ホスト）を
   **Cloudflare Access Application 配下に置く**ことを必須とする
   （Email OTP / Google など人認証）。
2. The system shall Access の後段で既存 `middleware/auth.ts`（Bearer API key）を流用し、
   人認証（Access JWT）とサービス認証（API key）を二段で適用する。
3. The system shall STEELO ルート専用の CORS ミドルウェアを実装し、
   環境変数 `STEELO_WEB_ORIGINS` に列挙された origin のみを許可する
   （既存の `cors({ origin: '*' })` は適用しない）。
4. The system shall **全ての DL** を Bearer 付き `fetch` + Blob 方式または
   短命（15分）の R2 署名付き URL で行い、`<a href="/api/..." download>` で
   API を直接呼ばない。
5. The system shall 既存ナビゲーション（`app-shell`）に「ドライバー」「ドライバー別名」
   「月次控除」「LINEメッセージ」「配車レコード」「Excelインポート」「支払明細生成」
   「監査ログ」のメニュー項目を追加する。
6. The system shall 既存LINE Harness機能（友だち、シナリオ、broadcast等）の
   メニュー・動作を変更しない（共存運用）。
7. When 任意の管理操作が失敗した場合、the system shall ユーザに分かりやすい
   日本語エラーメッセージを表示し、サーバログには技術的詳細を出力する。
8. The system shall 重要操作（インポート確定/上書き、支払明細生成、ジョブ投入、
   driver/driver_alias/driver_deduction 変更）について、`audit_logs` テーブルに
   `actor_id`, `actor_name`, `action`, `resource_type`, `resource_id`, `payload_json`
   を永続化する（`console.log` だけで終わらせない）。`audit_logs` は管理画面
   `/audit-logs` から検索可能とする。

### Requirement 7: データ整合性・非機能要件

**Objective:** 開発者として、月次運用に耐える整合性・性能・バックアップを担保したい。

#### Acceptance Criteria

1. The system shall 全金額をD1のINTEGER（円単位）で保持し、浮動小数誤差を
   発生させない。中間計算は number で扱い、**行単位で `Math.round()`** して
   円単位四捨五入する（`rounding_rule = 'per_line_round'` を永続化）。
2. The system shall D1の Time Travel（30日保持）を運用上のバックアップとして
   利用し、追加のバックアップ機構は Phase 1 では実装しない。PII を含むため
   復元手順は運用ドキュメントで明示する。
3. While 月1,000件規模の処理性能要件として、the system shall 以下を満たす:
   - **個別 xlsx 生成（同期API）**: 1ドライバー1ヶ月分を **2秒以内**で返却
   - **月次一括生成（payment_jobs）**: 20名分を **5分以内**で完了（非同期、
     Workers 同期 CPU 制約に依存しない）
   - 一括 INSERT は D1 のパラメータ100制約を考慮し、50行刻みで分割する
4. The system shall 全テーブルに `created_at` を持ち、更新が発生するテーブル
   には `updated_at` を持つ（JSTで保存）。
5. The system shall 既存LINE Harnessの命名規則（snake_case のテーブル名・列名）
   に準拠する。
6. The system shall マイグレーションは追記のみとし、列削除・型変更は別マイグレーション
   に分け、ロールバック手順を運用ドキュメントに残す。
7. The system shall `driver_payment_summaries` および `payment_summary_lines` を
   生成時スナップショットとして扱い、マスタ変更後も過去明細を再現可能にする
   （前述 Requirement 5 のスナップショット項目）。

### Requirement 8: ドライバー別名マスタ（F5の追加）

**Objective:** 管理者として、ExcelのDR名と社内のドライバー名にゆれ（旧姓・空白・
カナ違い等）がある場合に、別名マスタで吸収して未紐付けを減らしたい。

#### Acceptance Criteria

1. The system shall `driver_aliases` テーブルを提供し、`driver_id` と `alias_name`
   の組を管理する（`alias_name` は UNIQUE）。
2. When Excel取込時に DR 名を `drivers.name` で解決できなかった場合、
   the system shall `driver_aliases.alias_name` で再解決を試みる。
3. The system shall preview 画面で未紐付け DR 名一覧を表示し、各エントリから
   既存ドライバーへの別名登録を1クリックで行えるUIを提供する。
4. When 別名が登録された場合、the system shall 同一 preview のまま再判定して
   未紐付け件数を即時更新する（preview 期限内に限る）。

### Requirement 9: ドライバー月次控除マスタ（F5の追加）

**Objective:** 管理者として、ドライバーごとに月次の車両代/電算処理費/前払金を
入力し、支払明細生成にそのまま反映したい。

#### Acceptance Criteria

1. The system shall `driver_deductions` テーブル（`driver_id × period` UNIQUE）を提供する。
   列: `vehicle_cost`, `processing_fee`, `prepayment`, `notes`, `updated_at`, `updated_by`。
2. The system shall `PUT /api/driver-deductions` で month-level の控除を UPSERT する。
3. When 支払明細を生成する場合、the system shall 必ず当該月の `driver_deductions` を
   読み出して `calculatePayment` の `deductions` 引数に渡す（不在は 0 として扱う）。
4. The system shall 控除変更時に `audit_logs` に `action='deduction_update'` を残す。
5. The system shall 管理画面 `/driver-deductions` で月選択して全ドライバー分の
   控除を一覧編集できる UI を提供する。

### Requirement 10: 監査ログ

**Objective:** 運用者として、誰がいつ何をしたかをDB上で追跡できるようにしたい。

#### Acceptance Criteria

1. The system shall `audit_logs` テーブルを提供し、`actor_id`, `actor_name`, `action`,
   `resource_type`, `resource_id`, `payload_json`, `ip`, `user_agent`, `created_at` を記録する。
2. The system shall 以下の操作で必ず `audit_logs` を**同一トランザクション内で**書き込む:
   import_confirm / import_overwrite / import_archive / payment_generate /
   payment_batch_generate / payment_job_request / driver_create / driver_update /
   driver_archive / driver_alias_create / driver_alias_delete / deduction_update。
3. The system shall `GET /api/audit-logs` で actor / action / resource / 期間 で検索可能とする
   （管理者ロールのみ）。
4. The system shall `audit_logs` は論理削除・物理削除しない（保管はD1のTime Travelに任せる）。
