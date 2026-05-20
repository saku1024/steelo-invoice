# STEELO 稼働照合・ドライバー支払明細システム

## 1. プロジェクト概要

### 背景
軽貨物運送業を営むSTEELOは、元請け（BOND's株式会社）から配車を受け、
約20名のドライバーが日々1〜3件の配送案件を遂行している。
月間約1,000件の稼働データについて、元請けから届く支払明細Excelと
LINEグループの配車記録を照合し、漏れ・金額相違をチェックした上で
ドライバーごとの支払明細を作成する必要がある。
現在この作業は全て手作業で行われている。

### 目的
1. LINEグループの配車メッセージを自動蓄積・構造化
2. 元請えExcelと自動照合し、差分を検出
3. ドライバー別の支払明細Excelを自動生成

### フェーズごとの提供価値（読み違え防止）
- **Phase 1（MVP）**: 「**支払明細生成の半自動化**」。F1（LINE蓄積）、F3（Excel取込）、
  F5（基本CRUD）、F6（支払明細出力）を提供する。
  **自動照合（F4）はまだ動かない**ため、稼働照合（運送会社の最終ゴール）は
  Phase 1 完了時点では成立しない点を関係者と合意する。
- **Phase 2**: F2（Claude Haiku解析）+ F4（自動照合エンジン）を追加し、
  「稼働照合」を初めて完成させる。
- **Phase 3**: 照合精度改善、異常検知の高度化、月次レポート自動化。

### ユーザー
- 管理者: 1名（STEELO代表）— 照合確認・支払明細作成
- ドライバー: 約20名 — LINEで報告するだけ（システムは使わない）

### 元請け
- BOND's 株式会社（1社のみ）


## 2. 技術スタック

### ベース
- LINE Harness OSS（https://github.com/Shudesu/line-harness-oss）をフォークして拡張

### インフラ
- Runtime: Cloudflare Workers (Hono / TypeScript)
- DB: Cloudflare D1 (SQLite)
- Frontend: Next.js 15 (App Router) — LINE Harness既存管理画面を拡張
- Excel読込/出力: SheetJS (xlsx) — Cloudflare Workers対応済み
- LLM: Claude Haiku API（メッセージ解析）
- LINE: LINE Messaging API（Webhook受信）
- CI/CD: GitHub Actions

### コスト
- Cloudflare Workers + D1: ¥0
- LINE Messaging API: ¥0（受信のみ）
- Claude Haiku API（月1,000件解析）: 約¥500〜1,500
- 合計: 約¥500〜1,500/月


## 3. システム構成図

LINEグループ（×約20）
  元請え → 配車メッセージ（前日夜〜当日朝）
  ドライバー → 完了報告等
        | Webhook
        v
LINE Harness (Cloudflare Workers)
  |
  +-- [F1] メッセージ受信 & 蓄積
  |       |
  +-- [F2] Claude Haiku 解析 → 配車レコードDB
  |
  +-- [F3] 元請えExcelアップロード → 元請えデータDB
  |       |
  +-- [F4] ★自動照合エンジン
  |       |
  +-- [F5] 照合結果 管理画面
  |       |
  +-- [F6] ドライバー支払明細Excel出力
  |
  DB: Cloudflare D1


## 4. 機能詳細

### F1: LINEメッセージ受信・蓄積

LINE HarnessのWebhook機能を拡張し、グループメッセージを受信・保存する。

- 受信対象: 約20のドライバー別LINEグループ
- グループ名の命名規則: 「{名前}DR ...」→ ドライバー自動判定
- 保存対象: テキストメッセージ全件（画像・PDFはメタデータのみ）
- 送信者の判別: BOND's株式会社（配車メッセージ）/ ドライバー本人 / 管理者


### F2: 配車メッセージ解析（Claude Haiku）

元請え（BOND's）からの配車メッセージを構造化データに変換する。

配車メッセージの構造パターン:

  {ドライバー名}さん
  お疲れ様です。
  明日の案件詳細です。

  ※明日は{N}案件まであります。
  ※自発時間お知らせください。

  ①{業務名}
  {時刻} {場所} 集荷
  →{時刻}～{時刻} {場所} 行き
  動態管理番号→{番号}

  ②{業務名}
  {時刻} {場所} スタート
  →{時刻} まで{業務内容}

  ■{案件注意事項}

解析プロンプト:

  あなたは配送業の配車メッセージを構造化するアシスタントです。
  以下のLINEメッセージから配車情報を抽出してください。

  ルール:
  - 案件は①②③...の番号で区切られている
  - 業務名は番号の直後に記載（例: ①くるめし 距離便）
  - 時刻・場所・動態管理番号を抽出
  - ■以降の注意事項ブロックは案件データではないので無視
  - 「お疲れ様です」「よろしくお願いいたします」等の挨拶は無視
  - 日付は「明日の案件」→ メッセージ受信日+1日
  - 日付が明記されている場合はそちらを使用

  出力JSON:
  {
    "driver_name": "新井芳樹",
    "work_date": "YYYY-MM-DD",
    "total_tasks": 2,
    "tasks": [
      {
        "task_number": 1,
        "task_name": "くるめし 距離便",
        "start_time": "08:30",
        "pickup_location": "川口市並木",
        "end_time": "10:00〜10:30",
        "delivery_location": "練馬区東大泉",
        "management_number": "BND024"
      }
    ],
    "confidence": "high"
  }

解析失敗時の処理:
- confidence: "low" → status: "needs_review" としてDBに保存
- 管理画面で手動修正可能


### F3: 元請えExcelインポート

月1回、BOND'sから届く支払明細Excelをアップロード・取込。

Excelの構造:

ヘッダー部（1〜8行目付近）:
- 年月度、お支払い明細書、宛先（STEELO）
- 対象期間、支払予定日、支払方法
- 運賃合計（税抜）、手数料(7.5%)、立替、お支払い金額合計
- 車両代(修理代)、電算処理費、前払金

明細部（11行目〜）:
- A列: 日（1〜31）
- B列: 曜日
- C列: 業務名
- D列: 積込み先
- E列: 納品先
- F列: 開始時刻
- G列: 終了時刻
- H列: 距離(km)
- I列: 立替金
- J列: 運賃（税抜）
- K列: DR（ドライバー名）
- L列: 備考

特殊行: 運賃が「-」のもの（同便の従属行、セット案件の一部）
備考が次行にまたがるケースあり

インポート処理:
1. 管理画面からExcelファイルをアップロード
2. SheetJSでパース
3. ヘッダー部のサマリーデータを保存
4. 明細部を1行ずつ client_records テーブルに格納
5. 取込件数・サマリーをプレビュー表示
6. 管理者が「確定」ボタンで確定


### F4: 自動照合エンジン（★コア機能）

配車レコード（LINE由来）と元請えレコード（Excel由来）を自動マッチング。

マッチングロジック:
- 第1キー: 日付 + ドライバー名 + 業務名
- 第2キー（補助）: 積込先 or 納品先の部分一致
- 第3キー（補助）: 時間帯の近さ

照合結果の3分類:
- matched: LINE配車とExcelが一致 → 重要度:低（確認のみ）
- client_only: Excelにあるが LINE配車にない → 重要度:中（報告漏れの可能性）
- dispatch_only: LINE配車にあるが Excelにない → 重要度:★高（元請え計上漏れ＝請求漏れ）

追加チェック:
- 同一業務名の運賃が過去平均から大幅に乖離 → 警告
- 備考に「高速使用」とあるのに立替金が0 → 警告
- 運賃が「-」の行の妥当性チェック
### F5: 管理画面

LINE Harnessの既存Next.js管理画面にページを追加。

ページ一覧:
- ダッシュボード: 今月の照合状況サマリー（一致/不一致/未照合）、要確認件数
- 配車データ一覧: LINEから蓄積された配車レコードの閲覧・編集
- Excelインポート: ファイルアップロード・プレビュー・確定
- 照合結果: 3分類ごとの一覧、フィルタ（日付/DR/業務名/ステータス）、差分ハイライト
- 手動マッチ: 自動マッチできなかったレコードの手動紐付け
- ドライバーマスタ: 名前、LINEグループID、インボイス有無等の管理
- 支払明細生成: 期間選択 → プレビュー → Excel DL（個別 or ZIP一括）

認証: Cloudflare Access or Basic認証


### F6: ドライバー支払明細Excel出力

支払計算ロジック:

前提:
- 元請えExcelの運賃は税抜金額
- 手数料率（commission_rate）と消費税率（tax_rate）は **生成時のスナップショット値**を
  `driver_payment_summaries.commission_rate_snapshot` / `tax_rate_snapshot` に保存し、
  税制改正に追従できるようにする（既定は 0.075 / 0.10）
- 控除（車両代/電算処理費/前払金）は **per-driver per-period** で管理する
  （`driver_deductions` テーブル）。元請えExcelヘッダーの控除値は会社合計の参照値で、
  ドライバー個別の控除には使わない（全ドライバーに同じ金額を引かない）

  ① 手数料控除（行単位）:
     控除後運賃 = Excel運賃（税抜） × (1 - commission_rate_snapshot)
     例: 0.075 → × 0.925

  ② 消費税（インボイス有無で分岐、行単位）:
     インボイスあり → 運賃（税込） = 控除後運賃 × (1 + tax_rate_snapshot)
     インボイスなし → 運賃（税込） = 控除後運賃（税抜のまま）

  ③ 端数処理: **行単位で `Math.round()` 四捨五入**（合算後丸めではない。
     `rounding_rule = 'per_line_round'` として永続化）

  ④ 立替金: 全額そのまま

  ⑤ 最終支払額:
     お支払い金額合計 = Σ(行単位の運賃税込) + Σ(立替)
       - driver_deductions.vehicle_cost
       - driver_deductions.processing_fee
       - driver_deductions.prepayment
     （`driver_deductions` 未登録なら各 0 として計算）

計算例（1行のみ）:

  Excel上: 運賃 7,680円（税抜）、立替金 1,040円

  インボイスあり:
    7,680 × 0.925 = 7,104 → × 1.1 = 7,814.4 → 四捨五入 7,814円
    支払 = 7,814 + 1,040 = 8,854円

  インボイスなし:
    7,680 × 0.925 = 7,104円
    支払 = 7,104 + 1,040 = 8,144円

出力Excelフォーマット:

元請えの支払明細フォーマットをベースに以下を変更:

ヘッダー部:
- 宛名: 「{ドライバー名} 様」
- 「運賃合計」→「運賃合計（税込）」
- 手数料行: 削除 or ¥0
- お支払い金額合計 = 運賃合計（税込）+ 立替 - 控除項目

明細部:
- 「運賃」列 →「運賃（税込）」列（計算済みの値）
- 他の列はExcelデータをそのまま転記
- 当該ドライバーの行のみ抽出

出力単位と配信:
- 個別: 1ドライバー1ファイル（**同期API**、2秒以内目標）
  → fetch + Blob で DL（Bearer 必須、`<a download>` で API は呼ばない）
- 一括: 全ドライバー分をZIPで提供。ただし **非同期ジョブ** として
  処理し、`payment_jobs` を queued → R2 にxlsx/ZIPを保存 → UI で完了確認後に
  **R2 の短命署名付きURL（15分）** でブラウザが直接DLする
- 生成済みExcel/ZIPは R2 に保存し、`driver_payment_summaries.r2_xlsx_key` と
  `payment_jobs.r2_zip_key` から再ダウンロード可能
- 控除内訳・手数料率・税率・インボイス有無は生成時に
  `driver_payment_summaries` にスナップショット保存し、後からの再現性を担保


## 5. データモデル

### drivers（ドライバーマスタ）
- id: TEXT PK — UUID
- name: TEXT NOT NULL — 氏名
- name_kana: TEXT — カナ
- line_group_id: TEXT — LINEグループID
- line_group_name: TEXT — グループ名
- has_invoice: INTEGER DEFAULT 0 — インボイス登録 0=なし 1=あり
- is_active: INTEGER DEFAULT 1 — 有効フラグ
- notes: TEXT — 備考
- created_at: TEXT — 作成日時

### line_messages（LINEメッセージ生データ）
- id: TEXT PK — UUID
- group_id: TEXT — LINEグループID
- sender_name: TEXT — 送信者名
- message_text: TEXT — メッセージ本文
- message_type: TEXT — text / image / file
- received_at: TEXT — 受信日時
- is_dispatch: INTEGER DEFAULT 0 — 配車メッセージフラグ
- is_parsed: INTEGER DEFAULT 0 — 解析済みフラグ

### dispatch_records（配車データ / LINE解析結果）
- id: TEXT PK — UUID
- driver_id: TEXT FK — ドライバーID
- work_date: TEXT — 作業日 YYYY-MM-DD
- task_number: INTEGER — 案件番号（①②③）
- task_name: TEXT — 業務名
- pickup_location: TEXT — 積込先
- delivery_location: TEXT — 納品先
- start_time: TEXT — 開始時刻
- end_time: TEXT — 終了時刻
- management_number: TEXT — 動態管理番号
- raw_message_id: TEXT FK — 元メッセージID
- confidence: TEXT DEFAULT 'high' — 解析信頼度
- status: TEXT DEFAULT 'auto' — auto / needs_review / confirmed
- created_at: TEXT — 作成日時

### client_records（元請えExcelデータ）
- id: TEXT PK — UUID
- import_batch_id: TEXT — インポート単位ID
- period: TEXT — 対象月 "2026-03"
- work_day: INTEGER — 日（1-31）
- day_of_week: TEXT — 曜日
- task_name: TEXT — 業務名
- pickup_location: TEXT — 積込み先
- delivery_location: TEXT — 納品先
- start_time: TEXT — 開始
- end_time: TEXT — 終了
- distance_km: REAL — 距離(km)
- advance_payment: INTEGER — 立替金
- fare: INTEGER — 運賃（税抜）
- driver_name: TEXT — DR名
- notes: TEXT — 備考
- created_at: TEXT — 作成日時

### import_batches（Excelインポート履歴）
- id: TEXT PK — UUID
- period: TEXT — 対象月
- file_name: TEXT — ファイル名
- total_records: INTEGER — 取込件数
- total_fare: INTEGER — 運賃合計（税抜）
- total_advance: INTEGER — 立替合計
- commission_rate: REAL DEFAULT 0.075 — 手数料率
- imported_at: TEXT — インポート日時
- status: TEXT — pending / confirmed

### reconciliation（照合結果）
- id: TEXT PK — UUID
- dispatch_id: TEXT FK — 配車レコードID（nullable）
- client_record_id: TEXT FK — 元請えレコードID（nullable）
- match_status: TEXT — matched / client_only / dispatch_only
- match_score: REAL — マッチング確信度 0-1
- warnings: TEXT — JSON形式: 金額異常、立替矛盾等
- reviewed: INTEGER DEFAULT 0 — 確認済みフラグ
- reviewed_at: TEXT — 確認日時
- notes: TEXT — 管理者メモ

### driver_aliases（ドライバー別名マスタ）
- id: TEXT PK — UUID
- driver_id: TEXT FK — drivers.id
- alias_name: TEXT UNIQUE — Excel DR名のゆれ吸収（旧姓・空白・カナ違い等）
- created_at: TEXT — 作成日時

### driver_deductions（ドライバー月次控除マスタ）
- id: TEXT PK — UUID
- driver_id: TEXT FK — drivers.id
- period: TEXT — 対象月
- vehicle_cost: INTEGER DEFAULT 0 — 車両代(修理代)
- processing_fee: INTEGER DEFAULT 0 — 電算処理費
- prepayment: INTEGER DEFAULT 0 — 前払金
- notes: TEXT — メモ
- created_at: TEXT、updated_at: TEXT、updated_by: TEXT
- UNIQUE (driver_id, period)

### driver_payment_summaries（ドライバー支払サマリー / 生成時スナップショット）
- id: TEXT PK — UUID
- driver_id: TEXT FK — ドライバーID
- period: TEXT — 対象月
- import_batch_id: TEXT FK — 生成元バッチ（必須）
- payment_job_id: TEXT FK — 一括ジョブ経由なら job id
- driver_name_snapshot: TEXT — 生成時の氏名
- has_invoice_snapshot: INTEGER — 生成時点のインボイス有無
- commission_rate_snapshot: REAL — 生成時の手数料率（例 0.075）
- tax_rate_snapshot: REAL — 生成時の消費税率（例 0.10）
- rounding_rule: TEXT — 'per_line_round' を永続化
- total_fare_before_tax: INTEGER — 運賃合計（税抜・手数料控除後・行単位丸め後）
- total_fare_with_tax: INTEGER — 運賃合計（税込・行単位丸め後）
- total_advance: INTEGER — 立替金合計
- vehicle_cost: INTEGER — driver_deductions の値をスナップショット
- processing_fee: INTEGER — 同上
- prepayment: INTEGER — 同上
- final_amount: INTEGER — お支払い金額合計
- r2_xlsx_key: TEXT — R2 上の生成済み xlsx
- generated_at: TEXT — 生成日時
- UNIQUE (driver_id, period)

### payment_summary_lines（明細行スナップショット）
- id, summary_id FK, client_record_id FK, work_day, task_name,
  fare, fare_after_commission, fare_with_tax, advance_payment, excluded_from_calc

### payment_jobs（一括ZIP非同期ジョブ）
- id, period, status (queued/running/completed/failed), progress, total_drivers, done_drivers,
  r2_zip_key, error_message, requested_by, requested_at, started_at, completed_at
- 同一 period の queued/running は generated column + UNIQUE で重複排除

### import_previews（Excelプレビュー索引、本体はR2）
- preview_id PK, period, file_name, row_count, summary_json, r2_key,
  created_by, created_at, expires_at（既定 1h）

### audit_logs（監査ログ）
- id, actor_id, actor_name, action, resource_type, resource_id, payload_json,
  ip, user_agent, created_at
- インポート確定/上書き、支払生成、ジョブ投入、マスタ/控除変更、Webhook 保存失敗等を必ず記録


## 6. 業務名マスタ（初期データ / Excel実績から抽出）

距離便、3H便、4H便、3H便延長、4H便延長、マッハ、
築地チャーター、上野毛チャーター、中村橋チャーター、
追加チャーター便、チャーター便、
足立アネックス、台東アネックス、日本橋アネックス、豊島アネックス、
定期便、定期便延長、
名鉄ゴールデン航空、JR配送、1tJR配送、
黒田屋商店、三鈴印刷、炭酸ボンベ配送、ケーブル配送、
イベント21、富士物流、ロジコネット、ロジスティード、
郵便局配送、オリジン弁当、オリジン定期、
シェフコレ距離便、シェフコレ定期便、FTG距離便、
チルド配送、チルド案件、タイヤ配送、将泰庵、
ニチレキ、ハコベル、ナチュラル、キャラバン、樹商事、
カタギリ、デリバリーファーム、ト－アン、ミドリ安全、
玉子屋、西濃チャーター、ネットスーパー、ライフネットスーパー、
釜めし配送、水回収、水納品、搬入補助、
回収距離便、早朝距離便、印刷物配送、
距離同便1〜4、距離同便、
相殺分

※新しい業務名が出現した場合は自動追加される設計とする


## 7. 非機能要件

- **応答性**:
  - Webhook: 200 を 3秒以内に返却（D1 書き込みは waitUntil で非同期完了）
  - 個別 xlsx 生成（同期API）: 2秒以内
  - 月次一括生成（payment_jobs 非同期）: 20名分を 5分以内
- 可用性: Cloudflare Workers 99.9%+
- データ容量: 月1,000件 × 12ヶ月 × 5年 = 60,000件（D1 500MBで十分）
- **セキュリティ**:
  - 管理画面と STEELO API は **Cloudflare Access 必須**（推奨ではなく前提）
  - STEELO API は origin 限定 CORS（環境変数 `STEELO_WEB_ORIGINS`）
  - 全ての DL は Bearer 付き fetch + Blob か R2 短命署名付き URL（15分）
  - Excel アップロードは MIME / サイズ（≤10MB）/ シート数（≤5）/ 行数 / セル数 /
    数式 / 外部リンク / OLE / パスワード保護 で検証
- バックアップ: D1 Time Travel（30日間任意時点復元）。PII を含むことを運用ドキュメントで明示
- 端数処理: **行単位**で `Math.round()` 円単位四捨五入（合算後丸めは不可、業務合意済み）
- 監査: 重要操作は `audit_logs` に永続化、`console.log` だけで終わらせない
- 冪等性: LINE message_id UNIQUE で Webhook 再送時の重複保存を防ぐ。
  Excel preview は本番テーブル非書込、確定は generated column + UNIQUE で並行排他


## 8. 初期セットアップ手順

1. LINE Harness OSSをフォーク
2. LINE DevelopersでMessaging APIチャネル作成
3. Cloudflare D1に追加テーブル作成
4. ドライバーマスタ登録（20名、インボイス有無設定）
5. 各ドライバーLINEグループのID紐付け
6. Claude API key設定（Cloudflare Workers secrets）
7. 過去のExcelデータ1〜2ヶ月分をインポートしてテスト
8. デプロイ & Webhook URL設定


## 9. 開発フェーズ

### Phase 1（MVP / 「支払明細生成の半自動化」）
- F1: LINEメッセージ受信・蓄積（message_id UNIQUE で再送冪等性）
- F3: 元請えExcelインポート（プレビュー非永続化 + 上限値検証 + ヘッダー名探索 + driver_aliases）
- F5: 管理画面（ドライバー / ドライバー別名 / 月次控除 / Excelインポート / 配車レコード /
  支払明細生成 / 監査ログ）。Cloudflare Access 必須
- F6: ドライバー支払明細Excel出力（個別=同期API、一括=非同期ジョブ + R2 + 署名付きURL、
  スナップショット永続化）
- ※「自動照合」はまだ動かない。Phase 2 で完成させる。

### Phase 2
- F2: Claude Haiku解析
- F4: 自動照合エンジン
- F5: 照合結果画面・差分レポート

### Phase 3
- 照合精度改善（学習データ蓄積）
- 異常値検出の高度化
- 月次レポート自動生成
