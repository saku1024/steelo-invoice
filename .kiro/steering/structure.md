# Project Structure

## Organization Philosophy

pnpm workspaces によるモノレポ。`apps/*` がデプロイ単位（worker, web, liff）、
`packages/*` が共有ライブラリ（db, line-sdk, shared, sdk, plugin-template, mcp-server,
create-line-harness）。

レイヤ分離:
- **routes**: HTTPエンドポイント定義（リクエスト/レスポンス変換のみ）
- **services**: ビジネスロジック・複雑な処理フロー（Cron処理含む）
- **db（@line-crm/db）**: D1アクセス用クエリ関数。ドメイン単位でファイル分割
- **shared（@line-crm/shared）**: 全パッケージ共有の型定義

## Directory Patterns

### Worker API Routes
**Location**: `apps/worker/src/routes/`
**Purpose**: HTTPエンドポイント1ドメイン=1ファイル。`Hono<Env>` の子ルーターを
default export または named export し、`apps/worker/src/index.ts` でマウント
**Example**: `routes/friends.ts` → `app.route('/api/friends', friends)`

### Worker Services
**Location**: `apps/worker/src/services/`
**Purpose**: 複数routeから呼ばれる業務ロジック、Cronトリガーで動くバッチ処理、
外部API呼び出しの抽象化
**Example**: `services/step-delivery.ts`（シナリオ配信処理、Cronで毎5分実行）

### DB Queries
**Location**: `packages/db/src/`
**Purpose**: ドメイン1つに1ファイル。`getFoo(db, args)` / `upsertFoo(db, data)` /
`listFoo(db, filters)` の関数群をexport。D1の`prepare().bind().first()/all()`を
ラップする
**Example**: `packages/db/src/friends.ts` → `getFriendByLineUserId(db, lineUserId)`

### Migrations
**Location**: `packages/db/migrations/NNN_description.sql`
**Purpose**: 累積適用するDDL。番号3桁ゼロ埋め + snake_case の説明。
fresh deploy用に `packages/db/schema.sql` にも反映
**Example**: `046_drivers_and_dispatch.sql`

### Web Pages (App Router)
**Location**: `apps/web/src/app/<feature>/`
**Purpose**: Next.js 15 App Router 規約。`page.tsx`（ページ本体）、
`layout.tsx`（feature単位レイアウト）、`loading.tsx`（Suspense fallback）
**Example**: `app/friends/page.tsx`（友だち一覧）

### Web Components
**Location**: `apps/web/src/components/<feature>/`
**Purpose**: feature配下にfeature専用コンポーネント、`components/shared/` に
横断再利用部品、`components/ui/` にプリミティブUI
**Example**: `components/broadcasts/broadcast-form.tsx`

### Web API Client
**Location**: `apps/web/src/lib/api.ts`
**Purpose**: Worker API への fetch wrapper。APIキー自動付与、
camelCase↔snake_case 変換、エラーハンドリング

## Naming Conventions

- **Files**: kebab-case（`auto-reply.ts`, `broadcast-form.tsx`）。
  React コンポーネントファイルも kebab-case（中身の関数名はPascalCase）
- **DB Tables**: snake_case 複数形（`friends`, `dispatch_records`, `client_records`）
- **DB Columns**: snake_case（`line_user_id`, `created_at`）
- **TS Types**: PascalCase（`Friend`, `DispatchRecord`）
- **Functions**: camelCase。CRUD系は `get/list/create/update/upsert/delete + Domain` の
  動詞先頭命名
- **API Routes**: kebab-case の複数形リソース（`/api/friends`, `/api/dispatch-records`,
  `/api/client-records`）

## Import Organization

```typescript
// 1. 外部ライブラリ
import { Hono } from 'hono'
// 2. @line-crm/* パッケージ
import { upsertFriend, getLineAccounts } from '@line-crm/db'
import type { Friend } from '@line-crm/shared'
// 3. 相対import（同パッケージ内）
import type { Env } from '../index.js'
import { someService } from '../services/some-service.js'
```

**Path Aliases**:
- `@/`: Web側のみ。`apps/web/src/` をルートとする（`tsconfig.json` の paths で設定）
- Worker側は相対import。`.js` 拡張子をimportパスに付ける（ESM要件）

**Package依存ルール**:
- `apps/*` は `packages/*` に依存可
- `packages/*` 同士は限定的に依存（`@line-crm/db` → `@line-crm/shared` のみ）
- 循環依存禁止

## Code Organization Principles

- **routes は薄く**: HTTPの世界をビジネスロジックに翻訳するアダプター。
  バリデーション→servicesかdb関数を呼ぶ→レスポンス変換、までで完結させる
- **db関数はpure**: D1接続を引数で受け取る（`db: D1Database`）。
  グローバル状態を持たない
- **services は冪等性を意識**: Cron駆動の処理が多いため、再実行しても
  整合性が崩れない設計にする（バッチロック、idempotency keyなど）
- **新しいドメインを追加する手順**:
  1. `packages/db/migrations/NNN_*.sql` でテーブル追加（schema.sqlにも反映）
  2. `packages/shared/src/types.ts` に型追加
  3. `packages/db/src/<domain>.ts` でクエリ関数作成
  4. `apps/worker/src/routes/<domain>.ts` でAPIルート作成、`index.ts`でマウント
  5. `apps/web/src/app/<domain>/page.tsx` で管理画面追加、必要なら `components/<domain>/`
- **STEELOドメインの拡張は加算式**: 既存LINE Harnessのテーブル・ルートは触らず、
  運送業向けの新テーブル/ルート/ページを追加する。共存運用を前提

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
