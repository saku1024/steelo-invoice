### サマリー
全体の方向性は Phase 1 MVP として妥当ですが、現状の design.md は「動くはず」という前提が強く、Cloudflare Workers / D1 / 既存LINE Harnessの実装制約を詰め切れていません。特に、Excel生成の同期処理、認証、インポート冪等性、支払計算の監査性はこのまま実装に進むと手戻りが大きいです。

今の進捗を全体像から整理するとこれ: 要件は一通り書けていますが、設計はまだ承認前で、実装タスク化するには高リスク部分の再設計が必要です。  
次のタスクはこれ: design.md を修正し、「同期Workerでやる処理」と「R2/非同期ジョブ/再DLに逃がす処理」の境界、DB制約、認証方式、支払計算の固定ルールを明文化してください。

### 指摘事項（優先度順）

- **[CRITICAL] Excel一括生成を同期Workerで60秒以内とする根拠が弱い**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:25), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:316), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:749)
  - 問題: 20名分Excel+ZIPを「数秒」「60秒以内」と断定していますが、Workers CPU・メモリ・レスポンス制限、ライブラリ実測、Cloudflare Pages経由DLの制約が検証されていません。
  - 影響: 本番でタイムアウトし、月次支払明細が出せない可能性があります。
  - 推奨対応: Phase 1でも「同期は個別xlsxのみ」「一括ZIPはジョブ作成→R2保存→再DL」または少なくとも実測ベンチ結果と上限件数を設計に入れてください。

- **[CRITICAL] ダウンロードAPI設計が既存認証と噛み合っていない**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:524), [apps/worker/src/middleware/auth.ts](/home/user/steelo-invoice/apps/worker/src/middleware/auth.ts:57), [apps/web/src/lib/api.ts](/home/user/steelo-invoice/apps/web/src/lib/api.ts:76)
  - 問題: designは`<a href=... download>`でよいとしていますが、既存APIはAuthorizationヘッダ必須です。通常のaタグではBearerヘッダを送れません。
  - 影響: 支払明細DLが401になるか、認証を緩めて支払情報が漏れる設計になります。
  - 推奨対応: fetchでBlob取得してDLする、または短命署名付きURLを発行する方式に変更してください。

- **[CRITICAL] 管理画面認証が支払情報・PIIを扱うには弱い**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:755), [apps/web/src/components/auth-guard.tsx](/home/user/steelo-invoice/apps/web/src/components/auth-guard.tsx:16), [apps/web/src/lib/api.ts](/home/user/steelo-invoice/apps/web/src/lib/api.ts:69)
  - 問題: APIキーをlocalStorageに置く既存方式をそのまま使う設計です。XSS時にAPIキーが抜かれ、氏名・支払額・Excelが丸ごと読めます。
  - 影響: 支払情報の漏えいリスクが高いです。
  - 推奨対応: Cloudflare Accessを「推奨」ではなく必須に近い前提へ上げる、少なくともSTEELO系APIはAccess配下限定・スタッフ権限チェック・監査ログ必須にしてください。

- **[CRITICAL] CORS設計が文書と実装で矛盾している**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:759), [apps/worker/src/index.ts](/home/user/steelo-invoice/apps/worker/src/index.ts:107)
  - 問題: designは「CORSはWeb origin限定」と書いていますが、既存実装は`origin: '*'`です。
  - 影響: localStorageのAPIキー漏えい時、任意オリジンから支払APIを叩けます。
  - 推奨対応: 少なくとも新規STEELO APIは許可オリジンを環境変数で限定してください。

- **[HIGH] Drizzle ORM前提が設計に存在しない**
  - 該当ファイル: [.kiro/steering/tech.md](/home/user/steelo-invoice/.kiro/steering/tech.md:20), [apps/worker/package.json](/home/user/steelo-invoice/apps/worker/package.json:14), [packages/db/package.json](/home/user/steelo-invoice/packages/db/package.json:17)
  - 問題: ユーザー指定スタックにはDrizzle ORMがありますが、設計は`@line-crm/db`の生SQL関数前提で、依存にもDrizzleがありません。
  - 影響: 実装方針がブレ、スキーマ・型・マイグレーションの責任境界が曖昧になります。
  - 推奨対応: Phase 1は既存方針に合わせてDrizzleを使わない、と明記するか、Drizzle導入範囲を設計し直してください。

- **[HIGH] import_batchesのconfirmed一意性をDBで守っていない**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:671), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:608)
  - 問題: 同一periodのconfirmedはアプリ層で担保するとありますが、D1で競合リクエストが来ると二重confirmedが起きえます。
  - 影響: どのExcelを元に支払明細を作ったか不定になります。
  - 推奨対応: partial unique index相当の制約、または`period_confirmed_key`列を使ったUNIQUE制約でDB側でも守ってください。

- **[HIGH] Excelインポートのプレビュー段階で本データを書き込む設計が危険**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:269), [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:104)
  - 問題: preview時に`client_records`までINSERTし、confirmはstatus更新だけです。キャンセル・再プレビュー・期限切れpendingの扱いがありません。
  - 影響: pendingデータが残り、誤って集計対象に混ざるリスクがあります。
  - 推奨対応: previewはメモリ返却か一時テーブル扱いにし、確定時にconfirmed batchへ原子的に登録してください。残すならpending cleanupも必須です。

- **[HIGH] LINEメッセージの冪等性が不足している**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:570), [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:51)
  - 問題: `message_id`は保存しますがUNIQUE制約がありません。LINE Webhook再送で同じメッセージが重複保存されます。
  - 影響: 後続の照合・手動配車入力・監査で重複が発生します。
  - 推奨対応: `message_id`にUNIQUE、または`line_account_id + message_id`のUNIQUEを付けて、INSERT OR IGNORE系にしてください。

- **[HIGH] Webhook応答要件が既存実装方針とズレている**
  - 該当ファイル: [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:59), [apps/worker/src/routes/webhook.ts](/home/user/steelo-invoice/apps/worker/src/routes/webhook.ts:122)
  - 問題: 要件はD1書き込み含め3秒以内ですが、既存Webhookは`waitUntil`で非同期処理し、先に200を返す方針です。
  - 影響: 受け付けたがDB書き込み失敗した場合の扱いが曖昧になります。
  - 推奨対応: 「200返却」と「保存完了」を分けて定義し、保存失敗時のログ・再処理方針を追加してください。

- **[HIGH] 支払サマリーに生成元batchが保存されない**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:649), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:546)
  - 問題: `driver_payment_summaries`はperiod参照だけで、どの`import_batch_id`から生成したか持っていません。
  - 影響: Excelを上書きインポートした後、過去明細の再現性が壊れます。
  - 推奨対応: `import_batch_id`、計算式バージョン、税率、手数料率、生成時driver属性を保存してください。

- **[HIGH] 支払明細の再ダウンロード要件を満たす保存設計がない**
  - 該当ファイル: [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:168), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:149)
  - 問題: 「後から再ダウンロード可能」とありますが、Excel本体も生成時明細行スナップショットも保存しない設計です。
  - 影響: マスタ変更・Excel再取込後に同じ明細を再現できません。
  - 推奨対応: R2に生成済みxlsx/zipを保存するか、明細行ごとの計算結果スナップショットテーブルを追加してください。

- **[HIGH] 控除項目を全ドライバーに引く設計に見える**
  - 該当ファイル: [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:155), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:451)
  - 問題: 車両代・電算処理費・前払金がbatchヘッダー由来で、各ドライバー計算にそのまま渡されています。
  - 影響: 全ドライバーに同じ控除を重複適用する重大な支払ミスが起きます。
  - 推奨対応: 控除はドライバー別マスタ/調整テーブルに分離し、Excelヘッダーの会社全体控除とは別物として扱ってください。

- **[MEDIUM] 税率・インボイス制度変更への耐性がない**
  - 該当ファイル: [requirements.md](/home/user/steelo-invoice/requirements.md:226), [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:151)
  - 問題: 税率10%が固定値で、適用日や税率マスタがありません。
  - 影響: 将来の税率変更や期間またぎで過去明細の再計算が不正確になります。
  - 推奨対応: `tax_rate`を生成時に保存し、将来はperiod別税率に拡張できる形にしてください。

- **[MEDIUM] 四捨五入ルールは改善されたが、業務合意の記録が不足**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:440), [requirements.md](/home/user/steelo-invoice/requirements.md:230)
  - 問題: designでは行単位丸めを採用していますが、上位要求は「円単位」だけで、行単位か合算後かの業務合意がありません。
  - 影響: 元請け・ドライバーとの検算で数円差が出たとき説明できません。
  - 推奨対応: 要件側にも「明細行ごとに控除・税計算・四捨五入後に合算」と明記してください。

- **[MEDIUM] Excelテンプレート変更耐性が低い**
  - 該当ファイル: [requirements.md](/home/user/steelo-invoice/requirements.md:151), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:389)
  - 問題: 行番号・列固定の前提が強く、BOND's側の列追加やヘッダー位置変更に弱いです。
  - 影響: 月初に急にインポート不能になります。
  - 推奨対応: ヘッダー名探索、必須列検証、テンプレートバージョン、未知列warningを設計に入れてください。

- **[MEDIUM] ファイルアップロード検証が拡張子とSheetJSエラー頼み**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:763), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:708)
  - 問題: MIME、zip bomb、シート数、セル数、数式、外部リンク、巨大sharedStringsなどの制限が未定義です。
  - 影響: DoSや想定外パースでWorkerが落ちます。
  - 推奨対応: サイズ10MBに加え、シート数・行数・列数・セル数・処理時間の上限を明記してください。

- **[MEDIUM] PII・支払情報の監査ログがconsole.logだけ**
  - 該当ファイル: [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:711)
  - 問題: 重要操作をconsole.logに残すだけで、誰がいつ何をしたかDB上で追えません。
  - 影響: 誤操作・不正操作・支払トラブル時に追跡できません。
  - 推奨対応: `audit_logs`テーブルを追加し、インポート確定、上書き、支払生成、マスタ変更を記録してください。

- **[MEDIUM] ドライバー名の完全一致だけでは運用事故が起きやすい**
  - 該当ファイル: [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:110), [.kiro/specs/phase1-mvp/design.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/design.md:668)
  - 問題: Excelの表記ゆれ、空白、旧姓、カナ、略称に弱いです。
  - 影響: 未紐付けが増え、支払明細から漏れる可能性があります。
  - 推奨対応: `driver_aliases`またはExcel DR名マッピングテーブルを追加してください。

- **[LOW] Phase 1とプロダクト価値の期待値がずれている**
  - 該当ファイル: [requirements.md](/home/user/steelo-invoice/requirements.md:13), [.kiro/steering/product.md](/home/user/steelo-invoice/.kiro/steering/product.md:4), [.kiro/specs/phase1-mvp/requirements.md](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/requirements.md:22)
  - 問題: 全体価値は「自動照合」ですが、Phase 1はF2/F4なしです。MVP完了時点で「稼働照合」はまだ成立しません。
  - 影響: 関係者がPhase 1で照合までできると誤解します。
  - 推奨対応: Phase 1の価値を「支払明細生成の半自動化」と明確に下げ、照合はPhase 2と明記してください。

- **[LOW] spec.json上、design未承認なのに設計が実装可能に見える**
  - 該当ファイル: [.kiro/specs/phase1-mvp/spec.json](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/spec.json:12), [.kiro/specs/phase1-mvp/spec.json](/home/user/steelo-invoice/.kiro/specs/phase1-mvp/spec.json:21)
  - 問題: designは未承認・implementation不可ですが、design本文は断定調です。
  - 影響: レビュー指摘を潰す前にtasks/実装へ進みやすいです。
  - 推奨対応: 本レビューのCRITICAL/HIGHを修正してからdesign承認に進んでください。