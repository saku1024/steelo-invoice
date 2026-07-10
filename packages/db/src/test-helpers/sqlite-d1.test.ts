// batch() が本物の D1 batch() と同じ「単一トランザクションで全成功/全失敗」に
// なっているかの検証。Codex/Sol レビューで「以前の実装は各 statement を逐次
// await するだけで、途中失敗時に本当に全ロールバックされるか検証不能だった」と
// 指摘されたため、その挙動自体をここでテストする。
import { describe, it, expect } from 'vitest';
import { createSqliteD1, type SqliteD1 } from './sqlite-d1.js';

describe('createSqliteD1 - batch() の原子性', () => {
  it('batch 内の1件が失敗すると、それ以前に成功した statement も含めて全てロールバックされる', async () => {
    const h: SqliteD1 = createSqliteD1();
    try {
      await h.db
        .prepare(
          `INSERT INTO reconciliations
           (id, period, match_status, match_method, match_score, status, reviewed)
           VALUES ('dup-id', '2026-05', 'matched', 'strong', 1, 'active', 0)`
        )
        .bind()
        .run();

      await expect(
        h.db.batch([
          h.db
            .prepare(
              `INSERT INTO reconciliations
             (id, period, match_status, match_method, match_score, status, reviewed)
             VALUES ('new-id-1', '2026-05', 'matched', 'strong', 1, 'active', 0)`
            )
            .bind(),
          // id が既存行と重複 → PRIMARY KEY 違反で batch 全体が失敗するはず
          h.db
            .prepare(
              `INSERT INTO reconciliations
             (id, period, match_status, match_method, match_score, status, reviewed)
             VALUES ('dup-id', '2026-05', 'matched', 'strong', 1, 'active', 0)`
            )
            .bind(),
        ])
      ).rejects.toThrow(/UNIQUE constraint/);

      const row = await h.db
        .prepare(`SELECT COUNT(*) AS n FROM reconciliations WHERE id = 'new-id-1'`)
        .first<{ n: number }>();
      // batch が本当にトランザクションなら new-id-1 も無かったことになる
      expect(row!.n).toBe(0);
    } finally {
      h.close();
    }
  });

  it('batch 内が全て成功すれば通常通りコミットされる', async () => {
    const h: SqliteD1 = createSqliteD1();
    try {
      await h.db.batch([
        h.db
          .prepare(
            `INSERT INTO reconciliations
           (id, period, match_status, match_method, match_score, status, reviewed)
           VALUES ('ok-1', '2026-05', 'matched', 'strong', 1, 'active', 0)`
          )
          .bind(),
        h.db
          .prepare(
            `INSERT INTO reconciliations
           (id, period, match_status, match_method, match_score, status, reviewed)
           VALUES ('ok-2', '2026-05', 'matched', 'strong', 1, 'active', 0)`
          )
          .bind(),
      ]);
      const row = await h.db
        .prepare(`SELECT COUNT(*) AS n FROM reconciliations WHERE id IN ('ok-1', 'ok-2')`)
        .first<{ n: number }>();
      expect(row!.n).toBe(2);
    } finally {
      h.close();
    }
  });
});
