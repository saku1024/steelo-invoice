// PDF 生成テストの共通ヘルパ (fixture font を使う)
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderReconciliationReport,
  type ReconciliationRowForReport,
} from './pdf-templates/reconciliation-report.js';

const FIXTURE_FONT_PATH = resolve(
  __dirname,
  '../../tests/fixtures/NotoSansJP-Regular.ttf',
);

export async function renderWithFixture(
  rowCount: number,
  options: { period?: string; warningCounts?: Record<string, number> } = {},
): Promise<{
  bytes: Uint8Array;
  pageCount: number;
}> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontBytes = readFileSync(FIXTURE_FONT_PATH);
  const regular = await pdf.embedFont(fontBytes, { subset: true });
  const bold = regular;

  const rows: ReconciliationRowForReport[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push({
      matchStatus: i % 3 === 0 ? 'matched' : i % 3 === 1 ? 'client_only' : 'dispatch_only',
      matchMethod: i % 2 === 0 ? 'strong' : 'fuzzy',
      matchScore: i % 2 === 0 ? 1.0 : 0.7,
      dispatchTaskName: `業務${i}`,
      clientTaskName: `業務${i}`,
      workDate: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
      driverName: `ドライバー${i % 5}`,
      warnings: [],
    });
  }

  const result = await renderReconciliationReport(
    pdf,
    {
      period: options.period ?? '2026-05',
      generatedAt: '2026-05-21 12:00:00 JST',
      totals: {
        matched: Math.ceil(rowCount / 3),
        clientOnly: Math.ceil(rowCount / 3),
        dispatchOnly: Math.floor(rowCount / 3),
      },
      warningCounts: options.warningCounts ?? {},
      rows,
    },
    { regular, bold },
  );
  const bytes = await pdf.save();
  return { bytes, pageCount: result.pageCount };
}
