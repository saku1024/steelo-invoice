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
  - 認証は既存LINE Harnessと同一（APIキー + Cloudflare Access 推奨）

## Requirements

### Requirement 1: LINEグループメッセージ受信・蓄積（F1）

**Objective:** 管理者として、ドライバー別LINEグループに流れる配車メッセージ・
完了報告・画像等を全件Webhookで自動蓄積し、後続の照合・確認に使えるようにしたい。
これにより配車記録の手動転記をゼロにし、欠落を防止する。

#### Acceptance Criteria

1. When LINE Platform から `message` イベントが Webhook で送信された場合、
   the system shall ペイロードのソース種別（user / group / room）を判定し、
   group の場合は `line_messages` テーブルに `group_id`, `sender_user_id`,
   `sender_name`, `message_text`, `message_type`, `received_at` を保存する。
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
6. While Webhook応答性能要件として、the system shall 受信から 200 OK 返却までを
   3秒以内に完了する（D1書き込み含む。LINEの 1分タイムアウト制約内）。

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
   the system shall SheetJS でパースし、ヘッダー部から「対象月（YYYY-MM）」、
   「運賃合計（税抜）」、「立替合計」、「車両代」、「電算処理費」、「前払金」、
   「手数料率（既定 0.075）」を抽出する。
2. When Excelの明細部（11行目以降）を読み取った場合、the system shall 各行から
   A〜L列（日、曜日、業務名、積込み先、納品先、開始時刻、終了時刻、距離km、
   立替金、運賃、DR名、備考）を抽出し、`client_records` テーブルに保存する。
3. If 運賃列の値が `"-"` または空欄の場合、the system shall `fare = NULL` として
   保存し、エラー扱いとはしない（同便従属行・セット案件の一部として正常）。
4. When 備考列が次行にまたがる場合、the system shall 連続する空のメイン行
   （日・業務名が空）の備考を直前の明細行に連結して保存する。
5. The system shall インポートは2段階で行う。第1段階で「プレビュー」として
   取込件数・サマリーを `import_batches` に `status='pending'` で保存し、
   管理者が「確定」ボタンを押した時点で `status='confirmed'` に更新する。
6. While 同一対象月のExcelが既にインポート済みの場合、the system shall 警告を
   表示し、「上書き（既存confirmedバッチをarchivedにして新規取り込む）」または
   「キャンセル」を管理者に選択させる。
7. The system shall ExcelのDR名（K列）を `drivers.name` と完全一致で照合し、
   一致するドライバーがいなければ `client_records.driver_id = NULL` で保存し、
   プレビュー画面で「未紐付け件数」を警告表示する。

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
   以下の計算ロジックで支払額を算出する:
   - 控除後運賃（税抜）= `fare` × (1 - 手数料率)（手数料率はimport_batchの
     `commission_rate`、既定 0.925 倍）
   - 運賃（税込）= ドライバーの `has_invoice = 1` の場合は 控除後運賃 × 1.1、
     それ以外は 控除後運賃のまま
   - 各明細行の運賃を `Math.round()` で円単位四捨五入
   - 立替金（advance_payment）は全額そのまま加算
   - 最終支払額 = 運賃合計（税込・四捨五入済み）+ 立替合計 - 車両代 - 電算処理費 - 前払金
3. When `fare` が NULL（同便従属行）の行が存在する場合、the system shall 当該行を
   明細には掲載するが運賃計算からは除外する。
4. The system shall 元請けExcelのフォーマットをベースに、宛名を「{ドライバー名} 様」、
   「運賃合計」を「運賃合計（税込）」、手数料行を削除（または ¥0 表示）した
   Excelを `xlsx` で生成する。
5. The system shall 明細部に当該ドライバーの全行を作業日昇順で記載し、
   運賃列は計算済みの税込値を表示する。
6. When 管理者が「個別ダウンロード」を選択した場合、the system shall 単一ドライバー
   の `.xlsx` ファイルを返す。
7. When 管理者が「一括ダウンロード」を選択した場合、the system shall 全有効
   ドライバーの `.xlsx` をZIPに圧縮して返す。ファイル名は
   `{YYYY-MM}_{ドライバー名}_支払明細.xlsx` 形式。
8. The system shall 生成時点のサマリー（運賃合計、立替合計、最終支払額、
   インボイス有無）を `driver_payment_summaries` テーブルに保存し、後から
   再ダウンロード可能にする。
9. The system shall 計算結果がマイナス（前払金等の控除で運賃を下回る）の場合も
   そのまま出力し、Excel上に赤字表示で注意喚起する。

### Requirement 6: 管理画面の認証・基本UI（F5の基盤）

**Objective:** 管理者として、外部公開されない安全な管理画面で本機能を操作したい。

#### Acceptance Criteria

1. The system shall 既存LINE Harnessと同一の認証機構（APIキー保持の
   `auth-guard.tsx`）を本機能の画面にも適用する。
2. The system shall 既存ナビゲーション（`app-shell`）に「ドライバー」「LINEメッセージ」
   「配車レコード」「Excelインポート」「支払明細生成」のメニュー項目を追加する。
3. The system shall 既存LINE Harness機能（友だち、シナリオ、broadcast等）の
   メニュー・動作を変更しない（共存運用）。
4. When 任意の管理操作が失敗した場合、the system shall ユーザに分かりやすい
   日本語エラーメッセージを表示し、サーバログには技術的詳細を出力する。

### Requirement 7: データ整合性・非機能要件

**Objective:** 開発者として、月次運用に耐える整合性・性能・バックアップを担保したい。

#### Acceptance Criteria

1. The system shall 全金額をD1のINTEGER（円単位）で保持し、浮動小数誤差を
   発生させない。中間計算は number で扱い、最終出力時に `Math.round()` で
   四捨五入する。
2. The system shall D1の Time Travel（30日保持）を運用上のバックアップとして
   利用し、追加のバックアップ機構は Phase 1 では実装しない。
3. While 月1,000件規模の処理性能要件として、the system shall 単月の支払明細
   一括生成（20ドライバー分のZIP化）を60秒以内に完了する。
4. The system shall 全テーブルに `created_at` を持ち、更新が発生するテーブル
   には `updated_at` を持つ（JSTで保存）。
5. The system shall 既存LINE Harnessの命名規則（snake_case のテーブル名・列名）
   に準拠する。
