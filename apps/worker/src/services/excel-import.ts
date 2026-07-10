// STEELO Phase 1 F3: 元請け（BOND's）Excel のパース・検証サービス。
//
// 設計判断（Codex レビュー反映）:
//   - ファイル検証は多層: サイズ / シート数 / 行数 / 列数 / セル総数 /
//     sharedStrings サイズ / 数式 / 外部リンク / OLE / パスワード保護
//   - ヘッダー部は「行/列固定」ではなく「ヘッダー名（ラベル文字列）動的探索」を
//     優先し、テンプレ変更耐性を確保する
//   - 同便従属行（運賃が `-` または空欄）は fare=null で保持
//   - 連続する空メイン行の備考は直前明細行に連結する
import * as XLSX from 'xlsx';

export const XLSX_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxSheets: 5,
  maxRowsPerSheet: 5000,
  maxColsPerSheet: 50,
  maxTotalCells: 50_000,
  maxSharedStringsBytes: 5 * 1024 * 1024,
} as const;

export class ExcelValidationError extends Error {
  constructor(
    public code:
      | 'TOO_LARGE'
      | 'NOT_XLSX'
      | 'PASSWORD_PROTECTED'
      | 'TOO_MANY_SHEETS'
      | 'TOO_MANY_ROWS'
      | 'TOO_MANY_COLS'
      | 'TOO_MANY_CELLS'
      | 'SHARED_STRINGS_TOO_LARGE'
      | 'FORMULA_NOT_ALLOWED'
      | 'EXTERNAL_LINK_NOT_ALLOWED'
      | 'OLE_NOT_ALLOWED'
      | 'PARSE_ERROR'
      | 'HEADER_MISSING'
      | 'RATE_INVALID',
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ExcelValidationError';
  }
}

/**
 * 早期拒否のための検証。バッファレベルのマジックバイト/サイズ/zip構造を確認する。
 * SheetJS パース前に呼び出すこと。
 */
export function validateXlsxBuffer(buffer: ArrayBuffer): void {
  if (buffer.byteLength > XLSX_LIMITS.maxBytes) {
    throw new ExcelValidationError('TOO_LARGE', 'file exceeds 10MB limit', {
      bytes: buffer.byteLength,
    });
  }
  const bytes = new Uint8Array(buffer.slice(0, 8));
  // xlsx (zip) magic bytes "PK\x03\x04"
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new ExcelValidationError('NOT_XLSX', 'invalid xlsx magic bytes');
  }
  // Codex impl review HIGH #10 反映: ZIP central directory を直接スキャンして
  // sharedStrings.xml の size / 外部リンク / OLE オブジェクト / 埋込み等を検出する
  scanZipEntries(buffer);
}

/**
 * ZIP の central directory を走査し、危険なエントリの有無とサイズを早期検証する。
 * SheetJS パース前に呼ぶことで、巨大 sharedStrings や OLE 埋込みを通さない。
 */
function scanZipEntries(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // End of central directory signature 0x06054b50 を後ろから探す
  let eocdOffset = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new ExcelValidationError('NOT_XLSX', 'EOCD not found');
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const compressed = view.getUint32(p + 20, true);
    const uncompressed = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    void compressed;
    // sharedStrings サイズ上限
    if (name === 'xl/sharedStrings.xml' && uncompressed > XLSX_LIMITS.maxSharedStringsBytes) {
      throw new ExcelValidationError(
        'SHARED_STRINGS_TOO_LARGE',
        `sharedStrings.xml ${uncompressed} bytes exceeds limit ${XLSX_LIMITS.maxSharedStringsBytes}`
      );
    }
    // 外部リンク
    if (/^xl\/externalLinks\//.test(name)) {
      throw new ExcelValidationError(
        'EXTERNAL_LINK_NOT_ALLOWED',
        `external link entry detected: ${name}`
      );
    }
    // OLE / 埋込み
    if (/^xl\/embeddings\//.test(name) || /\/oleObject/i.test(name)) {
      throw new ExcelValidationError('OLE_NOT_ALLOWED', `embedded/OLE entry: ${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
}

export interface ParsedHeader {
  period: string; // "YYYY-MM"
  totalFare: number;
  totalAdvance: number;
  headerVehicleCost: number;
  headerProcessingFee: number;
  headerPrepayment: number;
  commissionRate: number;
  taxRate: number;
  templateVersion: string | null;
}

export interface ParsedRow {
  workDay: number;
  dayOfWeek: string | null;
  taskName: string | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  startTime: string | null;
  endTime: string | null;
  distanceKm: number | null;
  advancePayment: number;
  fare: number | null; // null = 同便従属行
  driverName: string | null;
  notes: string | null;
}

export interface ParsedExcel {
  header: ParsedHeader;
  rows: ParsedRow[];
  warnings: string[];
}

export function parseExcel(buffer: ArrayBuffer): ParsedExcel {
  validateXlsxBuffer(buffer);

  let wb: XLSX.WorkBook;
  try {
    // Codex impl review HIGH #10 反映: cellFormula:true で読み込んでフォーミュラ存在を
    // 確実に検出できるようにする（false だと cell.f は欠落するため見逃す）
    wb = XLSX.read(new Uint8Array(buffer), {
      type: 'array',
      cellFormula: true,
      cellHTML: false,
      cellNF: false,
      sheetStubs: false,
    });
  } catch (e) {
    if (e instanceof Error && /password/i.test(e.message)) {
      throw new ExcelValidationError('PASSWORD_PROTECTED', 'workbook is password-protected');
    }
    throw new ExcelValidationError('PARSE_ERROR', `parse failed: ${String(e)}`);
  }

  if (wb.SheetNames.length > XLSX_LIMITS.maxSheets) {
    throw new ExcelValidationError(
      'TOO_MANY_SHEETS',
      `workbook has ${wb.SheetNames.length} sheets (limit: ${XLSX_LIMITS.maxSheets})`
    );
  }

  // セル総数と数式/外部リンクの存在を検証
  let totalCells = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    if (range) {
      const cols = range.e.c - range.s.c + 1;
      const rows = range.e.r - range.s.r + 1;
      if (rows > XLSX_LIMITS.maxRowsPerSheet) {
        throw new ExcelValidationError(
          'TOO_MANY_ROWS',
          `sheet "${name}" has ${rows} rows (limit: ${XLSX_LIMITS.maxRowsPerSheet})`
        );
      }
      if (cols > XLSX_LIMITS.maxColsPerSheet) {
        throw new ExcelValidationError(
          'TOO_MANY_COLS',
          `sheet "${name}" has ${cols} cols (limit: ${XLSX_LIMITS.maxColsPerSheet})`
        );
      }
      totalCells += rows * cols;
    }
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const cell = (ws as Record<string, XLSX.CellObject>)[addr];
      if (cell && cell.f) {
        throw new ExcelValidationError(
          'FORMULA_NOT_ALLOWED',
          `formula at ${name}!${addr} is not allowed`
        );
      }
    }
  }
  if (totalCells > XLSX_LIMITS.maxTotalCells) {
    throw new ExcelValidationError(
      'TOO_MANY_CELLS',
      `total ${totalCells} cells (limit: ${XLSX_LIMITS.maxTotalCells})`
    );
  }

  // 主シート（先頭）を解析
  const firstSheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[firstSheetName];
  // 配列形式（行 × 列）で取得
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
  }) as unknown[][];

  const warnings: string[] = [];
  const header = extractHeader(aoa, warnings);
  const rows = extractRows(aoa, warnings);
  checkHeaderRowTotals(header, rows, warnings);

  return { header, rows, warnings };
}

/**
 * ヘッダーの合計値（運賃合計・立替合計）と明細行の実際の合計を突合する。
 * 列マッピングがずれている（例: テンプレート改版で列順が変わった）場合、
 * 明細は一見パースできてしまうため、金額ベースの突合でしか検知できない。
 * 不一致は import 自体は止めず preview の warnings に載せ、確定前に
 * スタッフが目視確認できるようにする。
 */
function checkHeaderRowTotals(
  header: ParsedHeader,
  rows: ParsedRow[],
  warnings: string[]
): void {
  if (rows.length === 0) {
    // Codex/Sol レビュー指摘: 明細ヘッダー行が見つからない等で行が 1 件も
    // 抽出できなかった場合、以前は突合自体をスキップしていたため、ヘッダーの
    // 合計が非ゼロ（＝本来は明細があるはず）でも警告無しで confirm できてしまった。
    if (header.totalFare !== 0 || header.totalAdvance !== 0) {
      warnings.push(
        `no detail rows were extracted but header totals are non-zero ` +
          `(totalFare=${header.totalFare}, totalAdvance=${header.totalAdvance}); ` +
          `check detail header row / column mapping before confirming`
      );
    }
    return;
  }
  const TOLERANCE_YEN = 1;
  const rowFareSum = rows.reduce((s, r) => s + (r.fare ?? 0), 0);
  const rowAdvanceSum = rows.reduce((s, r) => s + r.advancePayment, 0);
  if (Math.abs(rowFareSum - header.totalFare) > TOLERANCE_YEN) {
    warnings.push(
      `totalFare mismatch: header=${header.totalFare}, sum of rows=${rowFareSum} ` +
        `(diff=${rowFareSum - header.totalFare}); column mapping may be shifted`
    );
  }
  if (Math.abs(rowAdvanceSum - header.totalAdvance) > TOLERANCE_YEN) {
    warnings.push(
      `totalAdvance mismatch: header=${header.totalAdvance}, sum of rows=${rowAdvanceSum} ` +
        `(diff=${rowAdvanceSum - header.totalAdvance}); column mapping may be shifted`
    );
  }
}

// =============================================================================
// ヘッダー部の動的探索
// =============================================================================
// 期待されるラベル例（部分一致 or 包含で判定）:
//   対象月 / 対象期間 / 期間 → period (YYYY-MM)
//   運賃合計 → totalFare
//   立替合計 / 立替金合計 → totalAdvance
//   車両代 → headerVehicleCost
//   電算処理費 → headerProcessingFee
//   前払金 → headerPrepayment
//   手数料率 / 手数料(7.5%) → commissionRate
//   消費税率 / 税率 → taxRate
//   テンプレートバージョン / TemplateVersion → templateVersion (任意)

const HEADER_LABEL_PATTERNS: Record<keyof Omit<ParsedHeader, 'templateVersion'>, RegExp[]> = {
  period: [/対象月/, /対象期間/, /期間/],
  totalFare: [/運賃合計/],
  totalAdvance: [/立替.*合計/, /立替合計/, /立替金合計/],
  headerVehicleCost: [/車両代/],
  headerProcessingFee: [/電算処理費/, /処理費/],
  headerPrepayment: [/前払金/, /前払/],
  commissionRate: [/手数料率/, /手数料.*\(/],
  taxRate: [/消費税率/, /税率/],
};

function extractHeader(aoa: unknown[][], warnings: string[]): ParsedHeader {
  const found: Partial<Record<keyof ParsedHeader, unknown>> = {};

  // ヘッダー領域は明細部の前（典型的に 10 行目あたりまで）に存在すると想定
  const headerScanRows = Math.min(aoa.length, 15);
  for (let r = 0; r < headerScanRows; r++) {
    const row = aoa[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell !== 'string') continue;
      for (const key of Object.keys(HEADER_LABEL_PATTERNS) as (keyof typeof HEADER_LABEL_PATTERNS)[]) {
        if (found[key] !== undefined) continue;
        const patterns = HEADER_LABEL_PATTERNS[key];
        if (patterns.some((p) => p.test(cell))) {
          const value = findNeighborValue(aoa, r, c);
          if (value !== null) found[key] = value;
        }
      }
    }
  }

  // period 必須
  const periodRaw = found.period;
  let period: string | null = null;
  if (typeof periodRaw === 'string') {
    // Codex impl review MEDIUM #14 反映: 日本語表記 "2026年5月" にも対応
    const m1 = periodRaw.match(/(\d{4})[-/](\d{1,2})/);
    const m2 = periodRaw.match(/(\d{4})年\s*(\d{1,2})月/);
    const m = m1 ?? m2;
    if (m) period = `${m[1]}-${m[2].padStart(2, '0')}`;
  } else if (periodRaw instanceof Date) {
    period = `${periodRaw.getFullYear()}-${String(periodRaw.getMonth() + 1).padStart(2, '0')}`;
  } else if (typeof periodRaw === 'number') {
    // Excel シリアル日付（1900 epoch）
    const d = new Date(Math.round((periodRaw - 25569) * 86400 * 1000));
    period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (!period) {
    throw new ExcelValidationError('HEADER_MISSING', 'period (対象月) is required');
  }

  // テンプレートバージョン（任意）
  let templateVersion: string | null = null;
  for (let r = 0; r < headerScanRows; r++) {
    const row = aoa[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell === 'string' && /TemplateVersion|テンプレート.*バージョン/i.test(cell)) {
        const value = findNeighborValue(aoa, r, c);
        if (typeof value === 'string') templateVersion = value;
      }
    }
  }

  return {
    period,
    totalFare: numOrZero(found.totalFare, 'totalFare', warnings),
    totalAdvance: numOrZero(found.totalAdvance, 'totalAdvance', warnings),
    headerVehicleCost: numOrZero(found.headerVehicleCost, 'headerVehicleCost', warnings),
    headerProcessingFee: numOrZero(found.headerProcessingFee, 'headerProcessingFee', warnings),
    headerPrepayment: numOrZero(found.headerPrepayment, 'headerPrepayment', warnings),
    commissionRate: parseRate(found.commissionRate, '手数料率'),
    taxRate: parseRate(found.taxRate, '消費税率'),
    templateVersion,
  };
}

/**
 * 率（手数料率・税率）を正規化する。Codex impl review MEDIUM #13 反映:
 *   - 0.075 / 7.5 / "7.5%" / "0.075" / "7.5 %" 等を 0〜1 の小数に変換
 *
 * 以前はラベル未検出・パース失敗・範囲外の場合に無言でデフォルト値
 * （手数料率 7.5% / 税率 10%）へフォールバックしていたが、これだと
 * BOND 側のテンプレート改版でラベルの文字列や位置が変わった場合に
 * 気づかないまま全ドライバーの支払額を誤った率で計算してしまう。
 * そのため以降は検出・解釈できない場合はインポートを失敗させ、
 * 人間による確認を必須にする。
 */
function parseRate(v: unknown, fieldName: string): number {
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const trimmed = v.trim().replace(/\s/g, '');
    const isPercent = trimmed.endsWith('%');
    const numPart = trimmed.replace('%', '');
    // Codex/Sol レビュー指摘: numPart が空文字だと Number('') === 0 という JS の
    // 仕様により「空白のみ」「%だけ」のセルが無言で 0% として通ってしまう。
    // 0% はデフォルト値(7.5%/10%)より悪い結果（全額支払い扱い等）になりうるため、
    // 空文字は明示的に無効値として扱う。
    if (numPart !== '') {
      const num = Number(numPart);
      if (!Number.isNaN(num)) n = isPercent ? num / 100 : num;
    }
  }
  if (n === null || Number.isNaN(n)) {
    throw new ExcelValidationError(
      'RATE_INVALID',
      `${fieldName} not found or unparseable in header; refusing to default silently`,
      { field: fieldName, rawValue: v }
    );
  }
  // 1 以上は百分率表記とみなす（7.5 → 0.075）
  if (n >= 1 && n < 100) return n / 100;
  if (n < 0 || n >= 1) {
    throw new ExcelValidationError(
      'RATE_INVALID',
      `${fieldName} out of expected range (0-100%): ${n}`,
      { field: fieldName, rawValue: v }
    );
  }
  return n;
}

function findNeighborValue(aoa: unknown[][], r: number, c: number): unknown {
  // ヘッダーラベルの右隣 → 直下 → 2マス右 の順で探す
  const candidates = [
    aoa[r]?.[c + 1],
    aoa[r + 1]?.[c],
    aoa[r]?.[c + 2],
    aoa[r + 2]?.[c],
  ];
  for (const v of candidates) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function numOrZero(v: unknown, name: string, warnings: string[]): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[¥,\s]/g, ''));
    if (!Number.isNaN(n)) return n;
  }
  warnings.push(`${name} not found, defaulted to 0`);
  return 0;
}

// =============================================================================
// 明細部の抽出
// =============================================================================
// 明細ヘッダーラベル: 「日」「曜日」「業務名」「積込み先」「納品先」「開始」「終了」
// 「km」「立替」「運賃」「DR名」「備考」（部分一致）
// 明細ヘッダー行を見つけてからその下を読む。

const DETAIL_LABEL_PATTERNS: Record<keyof ParsedRow, RegExp[]> = {
  workDay: [/^日$/, /日$/],
  dayOfWeek: [/曜日/],
  taskName: [/業務名/, /業務/],
  pickupLocation: [/積込/, /積み込み/],
  deliveryLocation: [/納品/, /配送先/],
  startTime: [/開始/],
  endTime: [/終了/],
  distanceKm: [/km/i, /距離/],
  advancePayment: [/立替/],
  fare: [/^運賃/],
  driverName: [/DR名/, /ドライバー名/],
  notes: [/備考/, /メモ/],
};

function findDetailHeaderRow(aoa: unknown[][]): {
  rowIndex: number;
  colMap: Partial<Record<keyof ParsedRow, number>>;
} | null {
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const colMap: Partial<Record<keyof ParsedRow, number>> = {};
    let matchCount = 0;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell !== 'string') continue;
      for (const key of Object.keys(DETAIL_LABEL_PATTERNS) as (keyof typeof DETAIL_LABEL_PATTERNS)[]) {
        if (colMap[key] !== undefined) continue;
        if (DETAIL_LABEL_PATTERNS[key].some((p) => p.test(cell))) {
          colMap[key] = c;
          matchCount++;
          break;
        }
      }
    }
    // 「日」「業務名」「運賃」が揃ったらヘッダー行とみなす
    if (
      colMap.workDay !== undefined &&
      colMap.taskName !== undefined &&
      colMap.fare !== undefined &&
      matchCount >= 4
    ) {
      return { rowIndex: r, colMap };
    }
  }
  return null;
}

function extractRows(aoa: unknown[][], warnings: string[]): ParsedRow[] {
  const detailHeader = findDetailHeaderRow(aoa);
  if (!detailHeader) {
    warnings.push('detail header row not found; no rows extracted');
    return [];
  }
  const { rowIndex, colMap } = detailHeader;
  const out: ParsedRow[] = [];
  for (let r = rowIndex + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const workDayCell = colMap.workDay !== undefined ? row[colMap.workDay] : null;
    const taskNameCell = colMap.taskName !== undefined ? row[colMap.taskName] : null;
    const fareCell = colMap.fare !== undefined ? row[colMap.fare] : null;

    // メイン行は workDay または taskName が埋まっている
    const isMainRow =
      (typeof workDayCell === 'number' && workDayCell > 0) ||
      (typeof workDayCell === 'string' && /^\d+$/.test(String(workDayCell))) ||
      (typeof taskNameCell === 'string' && taskNameCell.trim() !== '');

    // 空メイン行（日・業務名空）の備考は直前行に連結
    const isContinuationRow =
      !isMainRow &&
      colMap.notes !== undefined &&
      typeof row[colMap.notes] === 'string' &&
      (row[colMap.notes] as string).trim() !== '';
    if (isContinuationRow && out.length > 0) {
      const last = out[out.length - 1];
      const additional = String(row[colMap.notes!]).trim();
      last.notes = last.notes ? `${last.notes}\n${additional}` : additional;
      continue;
    }
    if (!isMainRow) continue;

    const fareValue = parseFare(fareCell);
    const workDay = parseWorkDay(workDayCell);
    if (workDay === null) {
      // Codex verify MEDIUM #3 反映: 不正 workDay は silently skip せず confirm を止める
      throw new ExcelValidationError(
        'PARSE_ERROR',
        `row ${r + 1}: workDay must be integer 1-31 (got ${JSON.stringify(workDayCell)})`,
        { row: r + 1, value: workDayCell }
      );
    }
    out.push({
      workDay,
      dayOfWeek:
        colMap.dayOfWeek !== undefined ? toStr(row[colMap.dayOfWeek]) : null,
      taskName:
        colMap.taskName !== undefined ? toStr(row[colMap.taskName]) : null,
      pickupLocation:
        colMap.pickupLocation !== undefined ? toStr(row[colMap.pickupLocation]) : null,
      deliveryLocation:
        colMap.deliveryLocation !== undefined ? toStr(row[colMap.deliveryLocation]) : null,
      startTime: colMap.startTime !== undefined ? toStr(row[colMap.startTime]) : null,
      endTime: colMap.endTime !== undefined ? toStr(row[colMap.endTime]) : null,
      distanceKm:
        colMap.distanceKm !== undefined ? toNumOrNull(row[colMap.distanceKm]) : null,
      advancePayment:
        colMap.advancePayment !== undefined
          ? toIntOrZero(row[colMap.advancePayment])
          : 0,
      fare: fareValue,
      driverName:
        colMap.driverName !== undefined ? toStr(row[colMap.driverName]) : null,
      notes: colMap.notes !== undefined ? toStr(row[colMap.notes]) : null,
    });
  }
  return out;
}

/**
 * "1日" や "  3 " のような表記も含めて 1-31 の整数に正規化する。
 * Codex impl review MEDIUM #16 反映。
 */
function parseWorkDay(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.round(v);
    return n >= 1 && n <= 31 ? n : null;
  }
  if (typeof v === 'string') {
    const m = v.replace(/[\s日]/g, '').match(/^(\d{1,2})$/);
    if (m) {
      const n = Number(m[1]);
      return n >= 1 && n <= 31 ? n : null;
    }
  }
  return null;
}

function parseFare(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '―' || trimmed === 'ー') return null;
    const n = Number(trimmed.replace(/[¥,\s]/g, ''));
    if (Number.isNaN(n)) return null;
    return Math.round(n);
  }
  if (typeof v === 'number') return Math.round(v);
  return null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  return String(v);
}

function toIntOrZero(v: unknown): number {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[¥,\s]/g, ''));
    return Number.isNaN(n) ? 0 : Math.round(n);
  }
  return 0;
}

function toNumOrNull(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[\s]/g, ''));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
