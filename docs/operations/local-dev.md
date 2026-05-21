# Phase 1 MVP ローカル開発セットアップ

`pnpm dev` で Worker と D1 をローカル起動し、STEELO エンドポイントを curl 等で
端末から触れる状態を作る手順。`docs/operations/phase1-acceptance.md` の
手動チェックリスト実行や本実装の動作確認に使う。

## 1. 依存インストール（初回のみ）

```sh
pnpm install
# packages/line-sdk を事前ビルドしておく（vite dev で resolve できない場合がある）
pnpm --filter @line-crm/line-sdk build
```

## 2. ローカル D1 にスキーマを適用

```sh
cd apps/worker
pnpm exec wrangler d1 execute line-harness --local --file=../../packages/db/schema.sql
```

`drivers`, `driver_aliases`, `import_batches`, `payment_jobs`, `audit_logs` 等の
STEELO Phase 1 テーブルが作成される。

## 3. テスト用 staff（API key 認証用）を D1 に投入

```sh
pnpm exec wrangler d1 execute line-harness --local --command \
  "INSERT INTO staff_members (id, name, email, api_key, role, is_active) VALUES ('staff-test-1', 'Test Staff', 'test@example.com', 'test-api-key-12345', 'owner', 1)"
```

`api_key='test-api-key-12345'` で owner ロール。`/api/audit-logs` 等 admin 限定
エンドポイントもこのキーでアクセス可能。

## 4. `.dev.vars` を用意

```sh
cd apps/worker
cp .dev.vars.example .dev.vars
# 中身を必要に応じて編集
```

`STEELO_WEB_ORIGINS` を含む secret 系がここで wrangler dev に渡される。
`.dev.vars` 自体は `.gitignore` 対象。

## 5. dev サーバを起動

```sh
pnpm dev   # apps/worker から、port 8787 で起動
```

R2 (`STEELO_FILES`) と Queues (`payment-job-queue`) はバインディングが local mode で
ストアされる。

## 6. curl で E2E 動作確認

```sh
BASE=http://127.0.0.1:8787
KEY=test-api-key-12345
H="Authorization: Bearer $KEY"

# ドライバー作成
DRV=$(curl -sS -X POST "$BASE/api/drivers" -H "$H" -H 'Content-Type: application/json' \
  -d '{"name":"田中太郎","hasInvoice":true,"lineGroupId":"G_tanaka"}')
DRV_ID=$(echo "$DRV" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")

# 別名追加
curl -sS -X POST "$BASE/api/driver-aliases" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DRV_ID\",\"aliasName\":\"タナカ\"}"

# 月次控除登録
curl -sS -X PUT "$BASE/api/driver-deductions" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DRV_ID\",\"period\":\"2026-05\",\"vehicleCost\":1000,\"processingFee\":500,\"prepayment\":0}"

# Excel preview（multipart）
curl -sS -X POST "$BASE/api/excel-imports/preview" -H "$H" -F "file=@/path/to/test-bond.xlsx"
# → 返ってきた previewId を使って confirm
PV_ID="..."  # 上のレスポンスから取得
curl -sS -X POST "$BASE/api/excel-imports/confirm" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"previewId\":\"$PV_ID\"}"

# 個別支払明細生成（xlsx ダウンロード）
curl -sS -X POST "$BASE/api/payment-summaries/generate" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DRV_ID\",\"period\":\"2026-05\"}" -o payment.xlsx

# 監査ログ確認
curl -sS "$BASE/api/audit-logs" -H "$H" | python3 -m json.tool
```

## 7. 期待される計算結果（検算例）

田中太郎（インボイスあり）について 1 行が運賃 7,680 円 / 立替 0 円、別名 "タナカ" で
解決される 1 行が運賃 7,680 円 / 立替 1,040 円、月次控除が 1,000 + 500 + 0 のとき:

| 項目 | 計算 | 結果 |
|---|---|---|
| 行 1 税込 | 7680 × 0.925 × 1.1 = 7814.4 → Math.round | 7,814 |
| 行 2 税込 | 同上 | 7,814 |
| 税込合計 | 7814 + 7814 | 15,628 |
| 立替合計 | 0 + 1040 | 1,040 |
| 控除合計 | 1000 + 500 + 0 | 1,500 |
| **最終支払額** | 15628 + 1040 − 1500 | **15,168** |

出力された `payment.xlsx` の「お支払い金額合計」と一致すれば OK。

## 8. クリーンアップ

```sh
# ローカル D1 / R2 / Queues の状態は apps/worker/.wrangler 配下
rm -rf apps/worker/.wrangler
```

## 既知の dev-only 制約

- Vite dev server が OPTIONS preflight を Worker 到達前に処理してしまうため、
  `pnpm dev` 経由では steelo-cors の OPTIONS 経路を動作確認できない
  （GET/POST 等は正常に通る）。production Workers では問題なく動作する。
  ユニットテスト（`src/middleware/steelo-cors.test.ts`）で OPTIONS の挙動は検証済み。

## 関連ドキュメント

- 本番投入手順: [`docs/operations/cloudflare-access.md`](./cloudflare-access.md)
- 手動受入チェックリスト: [`docs/operations/phase1-acceptance.md`](./phase1-acceptance.md)
- Phase 1 設計: [`.kiro/specs/phase1-mvp/design.md`](../../.kiro/specs/phase1-mvp/design.md)
