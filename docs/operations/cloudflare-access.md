# Cloudflare Access 運用手順（STEELO Phase 1）

STEELO Phase 1 では PII（氏名）および支払情報を扱うため、**Cloudflare Access**
を STEELO エンドポイント全体の前段認証として**必須化**する。本ドキュメントは
ステージング／本番デプロイ前のセットアップと、デプロイ前チェックリストを規定する。

## 対象

以下を Access Application 配下に置く:

- 管理画面ホスト（Next.js デプロイ先。例 `admin.steelo.example.com`）
- Worker 上の以下のパス
  - `/api/drivers*`
  - `/api/driver-aliases*`
  - `/api/driver-deductions*`
  - `/api/excel-imports*`
  - `/api/payment-summaries*`
  - `/api/payment-summaries/jobs*`
  - `/api/audit-logs`

LINE Webhook (`/webhook`) と LIFF / R2 ストリーミング配信（短命署名付きURL）は
Access の対象外（署名検証や URL 自体が認可となるため）。

## 初期セットアップ

1. **Zero Trust ダッシュボード** → Access → Applications → Add an application
2. Self-hosted を選択し、Application domain にホストを設定
   - 例 1: `admin.steelo.example.com`（管理画面）
   - 例 2: `worker.steelo.example.com/api/drivers/*` 形式でパス指定
3. **Policies** で許可ルールを作成
   - 推奨: Email OTP（Email ends with `@steelo.example.jp` 等）
   - 強化: Google Workspace 連携（Identity provider に追加した上で Group 指定）
   - 開発時のみ: 個別メールアドレス（小規模の本番でも可）
4. **Session Duration** は短め（24h 目安）。 idle timeout も設定する
5. **Authentication** タブで MFA 必須化を確認（IdP 側または Access policy 側で）

## STEELO_WEB_ORIGINS の設定

Access 配下に置いたうえで、STEELO 専用 CORS ミドルウェアでも origin を限定する
（多層防御）。

```sh
# テスト環境
echo "https://admin.steelo.example.com" | wrangler secret put STEELO_WEB_ORIGINS

# 本番
echo "https://admin.steelo.example.com" | wrangler secret put STEELO_WEB_ORIGINS --env production
```

複数の origin を許可する場合はカンマ区切り（空白を入れない）。

## R2 バケット作成

```sh
# テスト環境
wrangler r2 bucket create steelo-files

# 本番（accountを切り替えて）
wrangler r2 bucket create steelo-files --env production
```

R2 ライフサイクルルール（自動削除）は wrangler.toml では設定できないため、
Cloudflare ダッシュボードで以下を追加する:

- `preview/` プレフィックス: 24時間後に削除（preview の TTL は 1h だが安全マージン）
- `generated/` プレフィックス: 13ヶ月後に削除（過去1年の支払明細を保管）

## Queues 作成（推奨）

```sh
wrangler queues create payment-job-queue
wrangler queues create payment-job-queue --env production
```

Queues が利用できないプランの場合、`payment_jobs` テーブルの `status='queued'`
を Scheduled cron（`*/5 * * * *`）が拾う実装で代替する（design.md F6-b 参照）。

## デプロイ前チェックリスト

毎回のデプロイ前に以下を確認する（CI では自動化しづらいため、人がチェック）:

- [ ] Access Application が STEELO 系の全パス／ホストに対して有効になっている
- [ ] Access Policy で許可されるアイデンティティが社内関係者のみに限定されている
- [ ] `STEELO_WEB_ORIGINS` シークレットが本番に設定済み（`wrangler secret list --env production`）
- [ ] R2 バケット `steelo-files` が存在し、ライフサイクルルールが設定済み
- [ ] Queues `payment-job-queue` が存在（または Scheduled fallback の運用合意済み）
- [ ] D1 マイグレーション `046_steelo_phase1.sql` が本番に適用済み
- [ ] `audit_logs` が前回デプロイ後にレコードを記録できている（疎通確認）

## 障害時の応急対応

- **Access が落ちた場合**: STEELO エンドポイントは事実上アクセス不能になる。Identity provider
  側の障害（Google 等）であれば Cloudflare 側で一時的に Email OTP の Policy を追加し、
  既知のメールアドレスのみ通過させる
- **Access を一時的に無効化したい場合**: 必ず時間を区切り、`audit_logs` で
  当該時間内のアクセスを全件確認できるようにする
- **本ドキュメントの参照元**: `.kiro/specs/phase1-mvp/design.md` の "Security Considerations" 節
