// STEELO Phase 3 F10: PDF 生成のテスト
//
// 大きく 2 グループ:
//   1. エラー型の存在確認 (fixture 不要、常に走る)
//   2. 構造テスト (Noto Sans JP fixture が必要、skipIf で fixture 無ければ skip)
//
// Codex Phase 3 round 2 MEDIUM #18 反映:
//   PDF binary snapshot ではなく、生成された PDFDocument を読み戻して構造を検証する
//   (page count、メタデータ、テキスト存在等)。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReportGenerationError, MAX_ROWS } from './pdf-generator.js';

const FIXTURE_FONT_PATH = resolve(
  __dirname,
  '../../tests/fixtures/NotoSansJP-Regular.ttf',
);
const hasFont = existsSync(FIXTURE_FONT_PATH);

describe('ReportGenerationError', () => {
  it('FONT_NOT_FOUND コード', () => {
    const err = new ReportGenerationError('FONT_NOT_FOUND', 'font missing');
    expect(err.code).toBe('FONT_NOT_FOUND');
    expect(err.name).toBe('ReportGenerationError');
    expect(err).toBeInstanceOf(Error);
  });

  it('ROW_COUNT_EXCEEDED コード', () => {
    const err = new ReportGenerationError('ROW_COUNT_EXCEEDED', 'too many rows');
    expect(err.code).toBe('ROW_COUNT_EXCEEDED');
  });

  it('INTERNAL コード', () => {
    const err = new ReportGenerationError('INTERNAL', 'unexpected');
    expect(err.code).toBe('INTERNAL');
  });

  it('MAX_ROWS は 500 (Codex round 2 MEDIUM #17)', () => {
    expect(MAX_ROWS).toBe(500);
  });
});

describe.skipIf(!hasFont)(
  'reconciliation-report structural (requires NotoSansJP-Regular.ttf fixture)',
  () => {
    it('0 行でも 1 ページ (summary page) は生成される', async () => {
      const { renderWithFixture } = await import('./pdf-test-helpers.js');
      const { pageCount, bytes } = await renderWithFixture(0);
      expect(pageCount).toBe(1);
      expect(bytes.byteLength).toBeGreaterThan(500);
    });

    it('25 行は 2 ページ', async () => {
      const { renderWithFixture } = await import('./pdf-test-helpers.js');
      const { pageCount } = await renderWithFixture(25);
      expect(pageCount).toBe(2);
    });

    it('200 行は 9 ページ (summary + detail 8)', async () => {
      const { renderWithFixture } = await import('./pdf-test-helpers.js');
      const { pageCount } = await renderWithFixture(200);
      expect(pageCount).toBe(9);
    });

    it('生成された PDF は pdf-lib で再ロード可能', async () => {
      const { renderWithFixture } = await import('./pdf-test-helpers.js');
      const { bytes } = await renderWithFixture(10);
      const { PDFDocument } = await import('pdf-lib');
      const reloaded = await PDFDocument.load(bytes);
      expect(reloaded.getPageCount()).toBeGreaterThan(0);
      const pages = reloaded.getPages();
      expect(pages[0].getWidth()).toBeCloseTo(595.28, 1);
      expect(pages[0].getHeight()).toBeCloseTo(841.89, 1);
    });

    it('warning 集計が summary ページに含まれる', async () => {
      const { renderWithFixture } = await import('./pdf-test-helpers.js');
      const { bytes } = await renderWithFixture(5, {
        warningCounts: { fare_deviation_high: 3, time_inversion: 1 },
      });
      const asString = Buffer.from(bytes).toString('latin1');
      // Noto Sans JP subset 埋込でも文字列は raw 出現する
      expect(asString).toMatch(/fare_deviation_high|time_inversion/);
    });
  },
);

// fixture が無い場合に skip されている旨をログに残す
if (!hasFont) {
  // eslint-disable-next-line no-console
  console.log(
    '[pdf-generator.test] fixture font not found, structural tests skipped (see tests/fixtures/README.md)',
  );
}

// 未使用警告抑止
void readFileSync;
