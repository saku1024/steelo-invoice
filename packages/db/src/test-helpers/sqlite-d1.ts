// テスト用: better-sqlite3 を D1Database API でラップする
// 本番では使わない（package.json の devDependencies のみ）。
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = Record<string, unknown>;

function makeStatement(db: Database.Database, sql: string) {
  let stmt: Database.Statement | null = null;
  const get = (): Database.Statement => {
    if (!stmt) stmt = db.prepare(sql);
    return stmt;
  };
  return (boundArgs: unknown[]) => {
    const trimmed = sql.trim().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT');
    const isPragma = trimmed.startsWith('PRAGMA');
    return {
      bind: (..._args: unknown[]) => {
        // unused, already bound above; keep for typing parity
        return makeBound(get(), boundArgs);
      },
      first: async <T = Row>(): Promise<T | null> => {
        const row = get().get(...boundArgs);
        return (row as T) ?? null;
      },
      all: async <T = Row>(): Promise<{ results: T[]; success: true; meta: object }> => {
        const rows = isSelect || isPragma ? get().all(...boundArgs) : [];
        return { results: rows as T[], success: true, meta: {} };
      },
      run: async () => {
        const info = get().run(...boundArgs);
        return {
          success: true,
          meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
        };
      },
    };
  };
}

function makeBound(stmt: Database.Statement, args: unknown[]) {
  return {
    first: async <T = Row>(): Promise<T | null> => {
      const row = stmt.get(...args);
      return (row as T) ?? null;
    },
    all: async <T = Row>(): Promise<{ results: T[]; success: true; meta: object }> => {
      const rows = stmt.all(...args);
      return { results: rows as T[], success: true, meta: {} };
    },
    run: async () => {
      const info = stmt.run(...args);
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
      };
    },
  };
}

export interface SqliteD1 {
  db: D1Database;
  raw: Database.Database;
  close(): void;
}

export function createSqliteD1(schemaSqlPath?: string): SqliteD1 {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');

  if (schemaSqlPath) {
    raw.exec(readFileSync(schemaSqlPath, 'utf8'));
  } else {
    // STEELO Phase 1 + 2 + 3 のテストで使えるよう、関連 migration を順に適用
    const migrationsDir = resolve(__dirname, '..', '..', 'migrations');
    const orderedMigrations = [
      '046_steelo_phase1.sql',
      '047_phase2_reconciliation.sql',
      '048_phase3_intelligence.sql',
    ];
    for (const name of orderedMigrations) {
      try {
        raw.exec(readFileSync(resolve(migrationsDir, name), 'utf8'));
      } catch (e) {
        // migration が見つからない場合は警告のみ（Phase 1 のみのテストでも動くように）
        if ((e as { code?: string }).code !== 'ENOENT') {
          throw e;
        }
      }
    }
  }

  const d1 = {
    prepare(sql: string) {
      const factory = makeStatement(raw, sql);
      return {
        bind: (...args: unknown[]) => makeBound(raw.prepare(sql), args),
        // 一部の呼び出しは bind を介さず直接 first/all/run を呼ぶことがあるため
        // フォールバックとして空引数で動くようにしておく
        first: async <T = Row>() => factory([]).first<T>(),
        all: async <T = Row>() => factory([]).all<T>(),
        run: async () => factory([]).run(),
      };
    },
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const results = [];
      for (const s of statements) {
        results.push(await (s as unknown as { run: () => Promise<unknown> }).run());
      }
      return results as unknown as D1Result[];
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return {
    db: d1,
    raw,
    close: () => raw.close(),
  };
}
