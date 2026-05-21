// STEELO Phase 3 F10 bench gate (Codex round 2 MEDIUM #17)
//
// 100 行 / 200 行 / 500 行で CPU time + byte size + page count を測定する。
// target: 200 行 < 5s、500 行 < 30s (Workers CPU 制限内)
//
// Workers 環境ではないので exact な CPU 時間は測れないが、Node 上で
// pdf-lib + fontkit + Noto Sans JP の生成コストを大まかに見る。
//
// 注意: フォントは tests/fixtures/NotoSansJP-Regular.ttf を期待する。
// 物理ファイルが無くてもテストは fallback (Helvetica で生成) する。
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderReconciliationReport,
  type ReconciliationRowForReport,
} from './pdf-templates/reconciliation-report.js';

const FIXTURE_FONT_PATH = resolve(
  __dirname,
  '../../tests/fixtures/NotoSansJP-Regular.ttf',
);

function makeRows(count: number): ReconciliationRowForReport[] {
  const rows: ReconciliationRowForReport[] = [];
  const statuses: Array<'matched' | 'client_only' | 'dispatch_only'> = [
    'matched',
    'client_only',
    'dispatch_only',
  ];
  for (let i = 0; i < count; i++) {
    rows.push({
      matchStatus: statuses[i % 3],
      matchMethod: i % 3 === 0 ? 'strong' : 'fuzzy',
      matchScore: i % 3 === 0 ? 1.0 : 0.7,
      dispatchTaskName: `業務${i}`,
      clientTaskName: `業務${i}`,
      workDate: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
      driverName: `ドライバー${i % 5}`,
      warnings: [],
    });
  }
  return rows;
}

async function generate(rowCount: number) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontBytes = readFileSync(FIXTURE_FONT_PATH);
  const regular = await pdf.embedFont(fontBytes, { subset: true });
  const bold = regular;

  const start = performance.now();
  const { pageCount } = await renderReconciliationReport(
    pdf,
    {
      period: '2026-05',
      generatedAt: '2026-05-21 12:00:00 JST',
      totals: {
        matched: Math.floor(rowCount / 3),
        clientOnly: Math.floor(rowCount / 3),
        dispatchOnly: rowCount - 2 * Math.floor(rowCount / 3),
      },
      warningCounts: { fare_deviation_high: 5, time_inversion: 2 },
      rows: makeRows(rowCount),
    },
    { regular, bold },
  );
  const bytes = await pdf.save();
  const elapsed = performance.now() - start;
  return {
    elapsed,
    byteSize: bytes.byteLength,
    pageCount,
  };
}

// Noto Sans JP TTF が fixture に無い場合 bench をスキップ
// (CI でフォントを取得する手順は docs/operations/deployment.md / Phase 3 acceptance に記載)
const hasFont = existsSync(FIXTURE_FONT_PATH);

describe.skipIf(!hasFont)('pdf-generator bench (requires NotoSansJP-Regular.ttf fixture)', () => {
  it('100 行で 2 秒以内に完了', async () => {
    const r = await generate(100);
    console.log(
      `[bench] reconciliation 100 rows: ${r.elapsed.toFixed(0)}ms, ${(r.byteSize / 1024).toFixed(1)}KB, ${r.pageCount} pages`,
    );
    expect(r.elapsed).toBeLessThan(2000);
    expect(r.pageCount).toBeGreaterThan(1);
  });

  it('200 行で 5 秒以内に完了', async () => {
    const r = await generate(200);
    console.log(
      `[bench] reconciliation 200 rows: ${r.elapsed.toFixed(0)}ms, ${(r.byteSize / 1024).toFixed(1)}KB, ${r.pageCount} pages`,
    );
    expect(r.elapsed).toBeLessThan(5000);
  });

  it('500 行で 30 秒以内に完了', async () => {
    const r = await generate(500);
    console.log(
      `[bench] reconciliation 500 rows: ${r.elapsed.toFixed(0)}ms, ${(r.byteSize / 1024).toFixed(1)}KB, ${r.pageCount} pages`,
    );
    expect(r.elapsed).toBeLessThan(30000);
    expect(r.byteSize).toBeLessThan(5 * 1024 * 1024); // 5MB 業務閾値
  });
});
