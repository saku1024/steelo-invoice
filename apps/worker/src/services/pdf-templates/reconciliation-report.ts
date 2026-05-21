// STEELO Phase 3 F10 P0: 照合結果 PDF レポートテンプレ
//
// matched / client_only / dispatch_only を 1 ページに集約 (件数 + 内訳)、
// 異常 warning 一覧を別ページに。A4 縦、Noto Sans JP 埋込。
import { PDFDocument, type PDFFont } from 'pdf-lib';
import type { StructuredWarning } from '@line-crm/shared';

export const RECONCILIATION_TEMPLATE_VERSION = 1;

export interface ReconciliationRowForReport {
  matchStatus: 'matched' | 'client_only' | 'dispatch_only';
  matchMethod: string;
  matchScore: number;
  dispatchTaskName: string | null;
  clientTaskName: string | null;
  workDate: string | null;
  driverName: string | null;
  warnings: StructuredWarning[];
}

export interface ReconciliationReportData {
  period: string;
  generatedAt: string;
  totals: {
    matched: number;
    clientOnly: number;
    dispatchOnly: number;
  };
  warningCounts: Record<string, number>;
  rows: ReconciliationRowForReport[];
}

interface FontPair {
  regular: PDFFont;
  bold: PDFFont;
}

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28;  // A4 portrait
const PAGE_HEIGHT = 841.89;
const FONT_SIZE_TITLE = 16;
const FONT_SIZE_SECTION = 13;
const FONT_SIZE_BODY = 10;
const FONT_SIZE_SMALL = 8;
const LINE_HEIGHT = 14;

/**
 * 照合結果 PDF を組み立てる。
 * 戻り値の PDFDocument は呼び出し側で `pdf.save()` して bytes を取得する。
 */
export async function renderReconciliationReport(
  pdf: PDFDocument,
  data: ReconciliationReportData,
  fonts: FontPair,
): Promise<{ pageCount: number }> {
  // ページ 1: サマリー + warnings 集計
  const summaryPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(summaryPage, data, fonts);
  let y = PAGE_HEIGHT - PAGE_MARGIN - 50;

  // セクション: 件数
  summaryPage.drawText('照合結果サマリー', {
    x: PAGE_MARGIN,
    y,
    size: FONT_SIZE_SECTION,
    font: fonts.bold,
  });
  y -= LINE_HEIGHT * 1.5;

  const totals = data.totals;
  const total = totals.matched + totals.clientOnly + totals.dispatchOnly;
  const lines = [
    `合計: ${total} 件`,
    `  matched (両方に存在): ${totals.matched} 件`,
    `  client_only (元請のみ): ${totals.clientOnly} 件`,
    `  dispatch_only (LINE のみ): ${totals.dispatchOnly} 件`,
  ];
  for (const line of lines) {
    summaryPage.drawText(line, {
      x: PAGE_MARGIN,
      y,
      size: FONT_SIZE_BODY,
      font: fonts.regular,
    });
    y -= LINE_HEIGHT;
  }

  // セクション: 異常 warning 集計
  y -= LINE_HEIGHT;
  summaryPage.drawText('異常検出', {
    x: PAGE_MARGIN,
    y,
    size: FONT_SIZE_SECTION,
    font: fonts.bold,
  });
  y -= LINE_HEIGHT * 1.5;

  const warningEntries = Object.entries(data.warningCounts).sort((a, b) => b[1] - a[1]);
  if (warningEntries.length === 0) {
    summaryPage.drawText('  異常 warning なし', {
      x: PAGE_MARGIN,
      y,
      size: FONT_SIZE_BODY,
      font: fonts.regular,
    });
    y -= LINE_HEIGHT;
  } else {
    for (const [type, count] of warningEntries) {
      summaryPage.drawText(`  ${type}: ${count} 件`, {
        x: PAGE_MARGIN,
        y,
        size: FONT_SIZE_BODY,
        font: fonts.regular,
      });
      y -= LINE_HEIGHT;
    }
  }

  // (footer ページ番号は全ページ生成後に一括描画、Codex full review MEDIUM #3 反映)

  // ページ 2 以降: 各 status の行一覧 (最大 25 行 / ページ)
  // Codex full review HIGH #5 反映: warning カラムを表示 (severity 別)
  const detailPages = paginateRows(data.rows);
  for (const pageRows of detailPages) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawHeader(page, data, fonts);
    let py = PAGE_HEIGHT - PAGE_MARGIN - 50;
    page.drawText('照合行 (詳細)', {
      x: PAGE_MARGIN,
      y: py,
      size: FONT_SIZE_SECTION,
      font: fonts.bold,
    });
    py -= LINE_HEIGHT * 1.5;
    drawDetailRow(
      page,
      fonts.bold,
      py,
      'status',
      'method',
      'score',
      'driver',
      'date',
      'task',
      'warn',
    );
    py -= LINE_HEIGHT;
    for (const row of pageRows) {
      const warnSummary = summarizeWarnings(row.warnings);
      drawDetailRow(
        page,
        fonts.regular,
        py,
        row.matchStatus,
        row.matchMethod,
        row.matchScore.toFixed(2),
        row.driverName ?? '-',
        row.workDate ?? '-',
        row.clientTaskName ?? row.dispatchTaskName ?? '-',
        warnSummary,
      );
      py -= LINE_HEIGHT;
    }
  }

  // ページ末尾: warning がある行だけ抽出した一覧 (Codex full review HIGH #5)
  const warnedRows = data.rows.filter((r) => r.warnings.length > 0);
  if (warnedRows.length > 0) {
    const wPages = paginateRows(warnedRows);
    for (const pageRows of wPages) {
      const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      drawHeader(page, data, fonts);
      let py = PAGE_HEIGHT - PAGE_MARGIN - 50;
      page.drawText('警告 warning 一覧', {
        x: PAGE_MARGIN,
        y: py,
        size: FONT_SIZE_SECTION,
        font: fonts.bold,
      });
      py -= LINE_HEIGHT * 1.5;
      for (const row of pageRows) {
        for (const w of row.warnings) {
          const sev = w.severity === 'warn' ? '⚠️' : 'ℹ️';
          const line = `${sev} [${w.type}] ${row.driverName ?? '-'} / ${row.workDate ?? '-'} / ${row.clientTaskName ?? row.dispatchTaskName ?? '-'}: ${w.message}`;
          page.drawText(truncate(line, 130), {
            x: PAGE_MARGIN,
            y: py,
            size: FONT_SIZE_SMALL,
            font: fonts.regular,
          });
          py -= LINE_HEIGHT;
          if (py < PAGE_MARGIN + 30) break;
        }
        if (py < PAGE_MARGIN + 30) break;
      }
    }
  }

  // フッターのページ番号を全ページに描画 (summary page の placeholder は廃止)
  // Codex full review MEDIUM #3 反映: footer の二重描画を避ける
  const allPages = pdf.getPages();
  for (let i = 0; i < allPages.length; i++) {
    drawFooter(allPages[i], fonts, i + 1, allPages.length);
  }

  return { pageCount: allPages.length };
}

function summarizeWarnings(warnings: ReconciliationRowForReport['warnings']): string {
  if (warnings.length === 0) return '';
  // 最も重い severity を 1 つだけ表示 (列幅節約)
  const warn = warnings.find((w) => w.severity === 'warn');
  if (warn) return `⚠️${warn.type}`;
  return `ℹ️${warnings[0].type}`;
}

function drawHeader(
  page: ReturnType<PDFDocument['addPage']>,
  data: ReconciliationReportData,
  fonts: FontPair,
): void {
  page.drawText('STEELO 運送株式会社', {
    x: PAGE_MARGIN,
    y: PAGE_HEIGHT - PAGE_MARGIN,
    size: FONT_SIZE_TITLE,
    font: fonts.bold,
  });
  page.drawText(`照合結果レポート ${data.period}`, {
    x: PAGE_MARGIN,
    y: PAGE_HEIGHT - PAGE_MARGIN - 20,
    size: FONT_SIZE_BODY,
    font: fonts.regular,
  });
  page.drawText(`生成: ${data.generatedAt}`, {
    x: PAGE_MARGIN,
    y: PAGE_HEIGHT - PAGE_MARGIN - 35,
    size: FONT_SIZE_SMALL,
    font: fonts.regular,
  });
}

function drawFooter(
  page: ReturnType<PDFDocument['addPage']>,
  fonts: FontPair,
  current: number,
  total: number,
): void {
  page.drawText(`${current} / ${total}`, {
    x: PAGE_WIDTH - PAGE_MARGIN - 30,
    y: PAGE_MARGIN - 10,
    size: FONT_SIZE_SMALL,
    font: fonts.regular,
  });
}

function drawDetailRow(
  page: ReturnType<PDFDocument['addPage']>,
  font: PDFFont,
  y: number,
  status: string,
  method: string,
  score: string,
  driver: string,
  date: string,
  task: string,
  warn = '',
): void {
  const cols = [
    { x: PAGE_MARGIN, text: status, w: 70 },
    { x: PAGE_MARGIN + 80, text: method, w: 50 },
    { x: PAGE_MARGIN + 135, text: score, w: 40 },
    { x: PAGE_MARGIN + 180, text: driver, w: 70 },
    { x: PAGE_MARGIN + 260, text: date, w: 70 },
    { x: PAGE_MARGIN + 340, text: task, w: 90 },
    { x: PAGE_MARGIN + 440, text: warn, w: 80 },
  ];
  for (const c of cols) {
    page.drawText(truncate(c.text, c.w / 6), {
      x: c.x,
      y,
      size: FONT_SIZE_SMALL,
      font,
    });
  }
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

const ROWS_PER_PAGE = 25;

function paginateRows(
  rows: ReconciliationRowForReport[],
): ReconciliationRowForReport[][] {
  const pages: ReconciliationRowForReport[][] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) {
    pages.push(rows.slice(i, i + ROWS_PER_PAGE));
  }
  // 行が無くても 0 ページを返す (sumamry page だけで OK)
  return pages;
}
