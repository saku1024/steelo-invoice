// STEELO Phase 3 F10: PDF 生成基盤
//
// pdf-lib + @pdf-lib/fontkit で Noto Sans JP を embed する。
// Codex Phase 3 round 1 CRITICAL #3: fontkit.registerFontkit() は custom font
// 埋込の必須前提。
//
// フォント取得失敗時は ReportGenerationError('font not found in R2') を throw。
// 500 行を超える大規模データは ReportGenerationError('row count exceeds 500') を throw
// (Phase 3 では分割せず明示 fail、Phase 4 で再評価)。
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  renderReconciliationReport,
  RECONCILIATION_TEMPLATE_VERSION,
  type ReconciliationReportData,
} from './pdf-templates/reconciliation-report.js';

export const FONT_R2_KEY = 'fonts/NotoSansJP-Regular.ttf';
export const FONT_BOLD_R2_KEY = 'fonts/NotoSansJP-Bold.ttf';

export const MAX_ROWS = 500;

export class ReportGenerationError extends Error {
  constructor(public code: 'FONT_NOT_FOUND' | 'ROW_COUNT_EXCEEDED' | 'INTERNAL', message: string) {
    super(message);
    this.name = 'ReportGenerationError';
  }
}

export interface PdfGenerationResult {
  bytes: Uint8Array;
  pageCount: number;
  byteSize: number;
  templateVersion: number;
}

/**
 * Reconciliation report PDF (P0) を生成する。
 * 戻り値の bytes を呼び出し側で R2 にアップロードする。
 *
 * @param fonts R2 storage (フォントを取得する)
 * @param data レポートデータ
 */
export async function generateReconciliationReportPdf(
  fonts: R2Bucket,
  data: ReconciliationReportData,
): Promise<PdfGenerationResult> {
  if (data.rows.length > MAX_ROWS) {
    throw new ReportGenerationError(
      'ROW_COUNT_EXCEEDED',
      `row count ${data.rows.length} exceeds ${MAX_ROWS}`,
    );
  }

  // R2 からフォント取得 (regular + bold)
  const regular = await fonts.get(FONT_R2_KEY);
  if (!regular) {
    throw new ReportGenerationError('FONT_NOT_FOUND', `font not found in R2: ${FONT_R2_KEY}`);
  }
  // Bold は無くても代替 (regular を bold としても使う) 可能だが、見出しは bold を期待
  let boldBytes: ArrayBuffer | null = null;
  const bold = await fonts.get(FONT_BOLD_R2_KEY);
  if (bold) {
    boldBytes = await bold.arrayBuffer();
  }
  const regularBytes = await regular.arrayBuffer();

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`STEELO 照合結果レポート ${data.period}`);
  pdf.setAuthor('STEELO 運送株式会社');
  pdf.setCreator('STEELO Phase 3 F10');

  const regularFont = await pdf.embedFont(regularBytes, { subset: true });
  const boldFont = boldBytes
    ? await pdf.embedFont(boldBytes, { subset: true })
    : regularFont;

  const { pageCount } = await renderReconciliationReport(pdf, data, {
    regular: regularFont,
    bold: boldFont,
  });

  const bytes = await pdf.save();
  return {
    bytes,
    pageCount,
    byteSize: bytes.byteLength,
    templateVersion: RECONCILIATION_TEMPLATE_VERSION,
  };
}
