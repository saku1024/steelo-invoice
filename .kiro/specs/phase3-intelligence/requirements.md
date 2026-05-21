# Requirements Document — Phase 3 Intelligence

## Introduction

STEELO Phase 2 までで、LINE → LLM 自動解析 → 元請け Excel との自動照合 → 支払明細
生成のフル自動化に到達した。月初の運用は劇的に短縮されたが、**「異常があった時に
気づくのは管理者が画面を開いた時」「元請けへの月次レポート作成は依然手作業」**
という残り課題がある。

Phase 3 では Phase 2 までの基盤を活かしつつ、以下 3 つの業務支援を追加する:

- **F8 異常検知強化**: 運賃中央値の自動学習、時刻矛盾、立替金整合性で warning の
  ノイズを下げて精度を上げる
- **F9 Slack 通知**: 照合完了 / 異常検出 / 月初リマインドをチャンネルに自動投稿し、
  管理者が画面を開く前に気づける状態にする
- **F10 月次レポート PDF**: 照合結果 + 支払明細サマリーを 1 枚の PDF にまとめ、
  元請け / 自社経理 / ドライバー向けに自動生成する

ベースは Phase 2 と同じ Cloudflare Workers + Hono + D1 + Next.js 15 構成。
PDF 生成は `pdf-lib` (Workers 互換) を使用。Slack は Incoming Webhook URL。

## Boundary Context

- **In scope**:
  - F8: `reconciliation.ts` の warnings 生成ロジック拡張 + `anomaly_baselines` 新規テーブル
  - F9: Slack webhook 送信サービス + `notification_settings` テーブル
  - F10: PDF 生成サービス + 月次レポートテンプレート + `/api/reports/*` ルート
  - 上記 3 機能の Web UI (`/settings/notifications`, `/reports`)
- **Out of scope**:
  - 異常検知のための LLM 利用（ルールベースで十分）
  - Slack 以外の通知チャネル（Email / LINE Notify など）
  - PDF カスタムテンプレート編集 UI（テンプレートはコード固定）
  - レポート PDF への手書きサイン / 押印フロー
- **Adjacent expectations**:
  - Phase 2 の `reconciliations.warnings` JSON 列を Phase 3 では構造化（`{type, severity, message, data}` の配列）に拡張する
  - `notification_settings` は単一管理者前提（multi-tenant 非対応）
  - PDF レポート出力先は既存 R2 `STEELO_FILES` bucket を流用

## Requirements

### Requirement 1: 運賃中央値の自動学習による異常検知 (F8-1)

**Objective:** 管理者として、Phase 2 の固定 50% 乖離しきい値ではなく、**過去 3 ヶ月の
ドライバー別 × 業務名別の中央値** をベースに運賃の異常を検出したい。これにより
false positive を減らし、本当に確認すべき行だけが highlight される状態にする。

#### Acceptance Criteria

1. The system shall 月初の照合実行前に、過去 3 ヶ月の `client_records` (confirmed
   batch のみ) から **driver_id × task_name 単位の運賃中央値・標準偏差** を
   `anomaly_baselines` テーブルに事前計算して保存する。
2. The system shall ベースライン算出に最低 5 サンプル必要とし、サンプル数 < 5 の
   組合せは「driver_id 単位の全体中央値」にフォールバックする。サンプル数 < 3 は
   ベースライン無しとして fare_deviation 検出をスキップする。
3. When 月次照合実行時に warning を生成する場合、the system shall
   - 該当 driver × task の baseline が存在: `(fare - median) / median` が
     ±2 SD を超えたら `fare_deviation_high` warning
   - baseline 無し: 検出スキップ（warning 出さない）
   - を判定する。
4. The system shall warning に以下のメタデータを構造化保存する:
   ```json
   {
     "type": "fare_deviation_high",
     "severity": "warn|info",
     "message": "運賃が中央値から +320% 乖離",
     "data": {
       "fare": 30000,
       "median": 7500,
       "sd": 1200,
       "sample_size": 12,
       "deviation_sigma": 18.75
     }
   }
   ```
5. The system shall `/api/anomaly-baselines/recompute?period=YYYY-MM` で
   手動再計算をトリガーできる。

### Requirement 2: 時刻矛盾と立替金整合性の検出 (F8-2)

**Objective:** 管理者として、dispatch_record / client_record の中に論理的に
ありえないデータ（集荷時刻 > 納品時刻、立替金あるのに明細無し等）が混入していたら
照合実行時に warning として可視化したい。

#### Acceptance Criteria

1. When dispatch_record / client_record で `start_time > end_time` が成立する場合、
   the system shall `time_inversion` warning を出力する。日跨ぎ（例: 23:00 → 02:00）
   は除外する（時刻差が 12 時間以内かどうかで判定）。
2. When client_record で `advance_payment > 0` だが dispatch_record の `task_name`
   が「立替」「実費」等のキーワードを含まない場合、the system shall
   `advance_payment_without_label` warning を info severity で出力する。
3. When 同 driver × 同日に 3 件以上の dispatch_record が存在する場合、the system
   shall `dispatch_overload` warning を info severity で出力する（業務量チェック）。
4. The system shall Phase 2 の `reconciliations.warnings` を JSON 配列のまま使い、
   1 行に複数 warning が並ぶケースを許容する。Web UI では severity 別に色分け表示する。

### Requirement 3: Slack 通知の基盤 (F9-1)

**Objective:** 管理者として、Slack Incoming Webhook URL を 1 度だけ登録すれば、
重要なイベント（月初リマインド / 照合完了 / 異常検出）が自動で投稿される状態にしたい。

#### Acceptance Criteria

1. The system shall `notification_settings` テーブル（単一行想定）で以下を管理する:
   - `slack_webhook_url` (TEXT, encrypted at rest via Workers KV or D1)
   - `enabled_events` (TEXT, JSON 配列: `['reconciliation_completed',
     'anomaly_detected', 'monthly_reminder', 'llm_parse_failed_streak']`)
   - `mention_users` (TEXT, JSON: `{anomaly_high: '@channel', default: ''}`)
   - `updated_at`
2. The system shall `/api/notification-settings` (GET / PUT) で管理画面から
   設定 + テスト投稿を可能にする。設定保存時には Webhook URL に
   「STEELO 通知設定が更新されました」というテストメッセージを送る。
3. The system shall Slack 投稿失敗時に audit_logs に記録し、management 画面でも
   「直近の投稿失敗」を表示する。リトライは exponential backoff で 3 回。
4. The system shall Webhook URL を `audit_logs.payload` に直接保存しない
   （URL 自体が secret 相当）。ログには `slack_webhook_set` のような action のみ記録する。

### Requirement 4: イベント別 Slack 通知ルール (F9-2)

**Objective:** 管理者として、4 種類のイベント発生時に Slack メッセージが届く状態
にしたい。各メッセージは Slack Block Kit で見やすく整形されている。

#### Acceptance Criteria

1. When 月次照合ジョブが `completed` になった場合、the system shall
   ```
   ✅ 2026-05 月の照合が完了しました
   matched: 87 / client_only: 3 / dispatch_only: 2
   ⚠️ 異常検出: fare_deviation_high 2 件 / time_inversion 1 件
   → 詳細: https://admin.example.com/reconciliations?period=2026-05
   ```
   を投稿する。
2. When 異常検出ロジック (Requirement 1 / 2) で severity=warn の warning が
   1 件以上発生した場合、the system shall **照合完了通知に集約**して投稿する
   （別メッセージにはしない、ノイズ対策）。
3. When 毎月 1 日 9:00 JST の cron で前月の confirmed `import_batch` が無い場合、
   the system shall「📋 前月 (2026-04) の元請け Excel がまだ取り込まれていません」
   というリマインドを投稿する。
4. When LLM 解析が直近 24 時間で 5 件連続失敗した場合、the system shall
   `llm_parse_failed_streak` 通知を投稿する（API key 失効 / Anthropic 障害の早期発見）。
5. The system shall 各通知に `enabled_events` の対応キーが立っていない場合は送信スキップする。

### Requirement 5: 月次レポート PDF 生成 (F10-1)

**Objective:** 管理者として、対象月を選択して 1 ボタンで以下 3 種の PDF を
生成・ダウンロードできる状態にしたい。元請けや経理に PDF をそのまま渡せる。

#### Acceptance Criteria

1. When `/reports` 画面で対象月 + レポート種別を選択して「生成」を押した場合、
   the system shall 以下 3 種のいずれかを生成する:
   - **元請けサマリー**: 取込済み client_records の合計売上、件数、ドライバー別小計
   - **照合結果レポート**: matched / client_only / dispatch_only の件数 + 異常 warning 一覧
   - **支払明細サマリー**: 月次支払明細の総額、ドライバー別小計、控除内訳
2. The system shall PDF は A4 縦・日本語フォント（Noto Sans JP）で `pdf-lib`
   ベースに生成し、ヘッダーに「STEELO 運送株式会社」+ 生成日時 + 対象月、
   フッターにページ番号を入れる。
3. The system shall 生成済み PDF を R2 `STEELO_FILES` の `reports/{period}/{type}_{jobId}.pdf`
   に保存し、15 分有効の signed URL でダウンロード可能にする。
4. The system shall PDF 生成ジョブは `report_jobs` テーブルで非同期管理し、
   `queued` → `running` → `completed` / `failed` の状態を提供する。
5. While 1 ヶ月分（200 行規模）の PDF 生成は 30 秒以内に完了する。

### Requirement 6: PDF テンプレート定義

**Objective:** 開発者として、PDF レイアウトをコードで定義し、デザイン変更時の
影響範囲を絞れる状態にしたい。

#### Acceptance Criteria

1. The system shall `services/pdf-templates/` 配下に各レポート種別ごとの
   `*.template.ts` を配置し、`render(data) → PDFDocument` 形式の純粋関数として
   実装する。
2. The system shall テンプレートのバージョンを `template_version` カラムに記録し、
   テンプレート変更時は bump して `report_jobs.template_version` に保存する
   （後から再生成して差分検証可能にする）。
3. The system shall 日本語フォント (`NotoSansJP-Regular.ttf`) を R2 に置き、
   `pdf-lib` の `embedFont(await STEELO_FILES.get('fonts/...').arrayBuffer())`
   経由で埋め込む。

### Requirement 7: 非機能要件

**Objective:** Phase 3 機能が Phase 1+2 の運用品質を維持しつつ追加されることを保証する。

#### Acceptance Criteria

1. The system shall Phase 1 + Phase 2 の全テスト (561 件) を維持する。Phase 3
   追加機能のテストは worker / db それぞれで unit + integration を備える。
2. The system shall PDF 生成を Cloudflare Workers の CPU 制限内 (30 秒) で完了させる。
   大規模データ (>500 行) の場合は Queues で分割処理する。
3. The system shall Slack 通知の送信失敗が Webhook 本来のフロー (照合完了処理など)
   をブロックしないよう、`waitUntil` で fire-and-forget する。
4. The system shall PDF 生成バイナリサイズが 5MB を超える場合、警告ログを出し、
   ダウンロード URL ではなく Cloudflare Email Workers でメール送信のフォールバックを
   将来検討する余地を残す（Phase 3 では fail でよい）。
5. The system shall `audit_logs.action` に新規アクションを追加する:
   `anomaly_baseline_recompute` / `slack_notification_sent` / `slack_notification_failed` /
   `report_generated` / `notification_settings_updated`

### Requirement 8: データモデル拡張

**Objective:** Phase 3 で必要となる新規テーブルとカラム拡張を整理する。

#### Acceptance Criteria

1. The system shall migration `048_phase3_intelligence.sql` で以下を追加する:
   - `anomaly_baselines` (driver_id, task_name, period_range, median, sd, sample_size,
     computed_at)
   - `notification_settings` (id PRIMARY KEY (=1 固定), slack_webhook_url,
     enabled_events JSON, mention_users JSON, last_test_at, last_error, updated_at)
   - `report_jobs` (id, period, report_type, status, template_version, r2_key,
     dispatch_count, requested_by, requested_at, started_at, completed_at,
     error_message)
2. The system shall `reconciliations.warnings` の中身を JSON 配列のまま使うが、
   各要素を `{type, severity, message, data}` 構造に変更する（Phase 2 の文字列配列
   からの破壊的変更）。
3. The system shall Phase 2 の既存 `reconciliations` 行にも構造化 warning を
   遡及適用するための再計算スクリプトを `scripts/migrate-warnings.ts` で提供する
   （任意実行、未実行でも新 warning フォーマットの判定は可能にする）。
