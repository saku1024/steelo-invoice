# Technology Stack

## Architecture

エッジ実行を前提としたサーバーレス・モノレポ構成。
Cloudflare Workers (Hono) を唯一のAPIサーバー（source of truth）とし、
Next.js 15 管理画面・LIFFアプリ・SDKは全てWorker APIを叩くconsumerとして動作する。

- **Runtime**: Cloudflare Workers（V8 isolate、Node.js非互換のためxlsx/crypto等は
  Workers対応版を使用）
- **DB**: Cloudflare D1（SQLite互換、Time Travel 30日保持）
- **モノレポ**: pnpm workspaces（`apps/*` と `packages/*`）
- **データフロー**: D1 ↔ Worker（Hono routes）↔ Web/LIFF/SDK

## Core Technologies

- **Language**: TypeScript（全パッケージで strict mode）
- **Backend Framework**: Hono（Cloudflare Workers）
- **Frontend Framework**: Next.js 15（App Router、React Server Components対応）
- **DB**: Cloudflare D1（SQLite）。アクセス層は `@line-crm/db` パッケージのクエリ関数
- **Runtime**: Node.js 20+（開発・ビルド時のみ）、本番は Cloudflare Workers V8
- **Package Manager**: pnpm 9.15.4

## Key Libraries

- **Hono**: Worker のルーティング・ミドルウェア
- **@line-crm/line-sdk**: LINE Messaging API ラッパー（typed client + webhook署名検証）
- **@line-crm/db**: D1 アクセス用クエリ関数群（30+ ファイル、ドメイン別）
- **@line-crm/shared**: Worker/Web/LIFF/SDK 共有型定義（`Friend`, `Broadcast`,
  `ApiResponse<T>` 等）
- **xlsx (SheetJS)**: Excel読み書き（Cloudflare Workers対応版）— Phase 1 で新規導入
- **Anthropic SDK**: Claude Haiku API（Phase 2 でメッセージ解析）

## Development Standards

### Type Safety
- TypeScript strict mode。`any` は禁止（design-principlesに従う）
- API境界では Zod 等で入力検証推奨。共有型は `@line-crm/shared` に集約
- D1 から取り出した行は snake_case、API/フロントは camelCase に変換するレイヤを
  Worker の routes 層で吸収

### Code Quality
- 既存LINE HarnessのESLint/Prettierルールを継承
- 関数は責務単位で分割。`routes/*.ts` はリクエスト処理に専念し、
  ビジネスロジックは `services/*.ts` または `@line-crm/db` の関数へ委譲

### Testing
- Vitest（worker側）。`*.test.ts` をルートと同じディレクトリに配置する慣例
- Cloudflare Workers ランタイムを `vitest.config.ts` で `@cloudflare/vitest-pool-workers`
  経由でエミュレート
- D1 はローカルSQLiteにマイグレーションを適用してテストする

## Development Environment

### Required Tools

- Node.js 20+
- pnpm 9.15.4（`package.json` の packageManager で固定）
- wrangler 4（Cloudflare CLI、開発・デプロイ・D1操作）

### Common Commands

```bash
# Worker開発
pnpm dev:worker          # apps/worker をローカル起動 (wrangler dev)
# Web開発
pnpm dev:web             # apps/web を Next.js dev mode で起動
# DBマイグレーション
pnpm db:migrate:local    # ローカルD1にschema.sql適用
pnpm db:migrate          # 本番D1にschema.sql適用
# Build
pnpm build               # 全パッケージビルド (pnpm -r build)
# Deploy
pnpm deploy:worker       # Workerデプロイ (wrangler deploy)
```

新規migrationを追加するときは `packages/db/migrations/NNN_descriptive_name.sql` を作成し、
`schema.sql` にも反映する（schema.sqlはfresh deploy用、migrationsは累積適用用）。

## Key Technical Decisions

- **Worker一元化**: Web/LIFF/SDK は全て Worker API を叩く。直接 D1 を触らない。
  これにより API key 認証・レート制限・ログを一箇所に集約できる
- **D1 で十分**: 月1,000件 × 12ヶ月 × 5年 = 60,000件規模。D1 の 500MB枠で
  ストレージは余裕。Time Travel でバックアップ不要
- **xlsx は Workers 対応版**: Cloudflare Workers では Node.js の `fs` 等が使えないため、
  SheetJS の ESM build を Worker bundle に同梱する。大容量ファイル処理時は
  R2 経由のストリーミングを検討（Phase 1 は同期処理で十分）
- **金額計算は整数（円単位）**: 浮動小数誤差を避けるため D1 上は INTEGER で保持。
  消費税計算等の中間値は number で扱い、最終結果を `Math.round()` で四捨五入
- **既存 LINE Harness のテーブルを尊重**: `friends`, `line_accounts`, `messages_log` 等は
  そのまま流用。運送業ドメインの新テーブル（`drivers`, `dispatch_records`,
  `client_records` 等）を追加する形で拡張する

---
_Document standards and patterns, not every dependency_
