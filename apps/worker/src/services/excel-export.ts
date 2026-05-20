// STEELO Phase 1 F6: ドライバー別支払明細 Excel ビルダー。
//
// BOND's の支払明細フォーマットを土台に以下を変更:
//   - 宛名「{ドライバー名} 様」
//   - 「運賃合計」→「運賃合計（税込）」
//   - 手数料行: 削除（¥0 表示）
//   - 明細運賃列: 行単位四捨五入後の税込値
//   - 当該ドライバーの行のみ
//   - マイナス値は赤字（フォント色 FF0000）
import * as XLSX from 'xlsx';
import type { PaymentResult } from '@line-crm/shared';

export interface ExportInput {
  driver: { name: string; hasInvoice: boolean };
  period: string;
  records: {
    workDay: number;
    dayOfWeek: string | null;
    taskName: string | null;
    pickupLocation: string | null;
    deliveryLocation: string | null;
    startTime: string | null;
    endTime: string | null;
    distanceKm: number | null;
    advancePayment: number;
    fare: number | null;
    notes: string | null;
  }[];
  result: PaymentResult;
}

export function buildDriverExcel(input: ExportInput): Uint8Array {
  const wb = XLSX.utils.book_new();
  const aoa: unknown[][] = [];

  // ヘッダー部
  aoa.push([`お支払い明細書`, null, null, null]);
  aoa.push([`宛先`, `${input.driver.name} 様`, null, null]);
  aoa.push([`対象月`, input.period, null, null]);
  aoa.push([`インボイス`, input.driver.hasInvoice ? 'あり' : 'なし', null, null]);
  aoa.push([null, null, null, null]);
  aoa.push([`運賃合計（税抜・手数料控除後）`, input.result.totalFareBeforeTax, null, null]);
  aoa.push([`運賃合計（税込）`, input.result.totalFareWithTax, null, null]);
  aoa.push([`立替合計`, input.result.totalAdvance, null, null]);
  aoa.push([`車両代`, input.result.vehicleCost, null, null]);
  aoa.push([`電算処理費`, input.result.processingFee, null, null]);
  aoa.push([`前払金`, input.result.prepayment, null, null]);
  aoa.push([`お支払い金額合計`, input.result.finalAmount, null, null]);
  aoa.push([null, null, null, null]);

  // 明細ヘッダー
  const detailHeaderRowIdx = aoa.length;
  aoa.push([
    '日',
    '曜日',
    '業務名',
    '積込み先',
    '納品先',
    '開始',
    '終了',
    'km',
    '立替',
    '運賃（税込）',
    '備考',
  ]);

  // 明細行
  // result.fareLines は records と同じインデックスで対応する
  const lineFareMap = new Map<number, { fareWithTax: number | null; excluded: boolean }>();
  for (let i = 0; i < input.records.length; i++) {
    const fl = input.result.fareLines[i];
    lineFareMap.set(i, {
      fareWithTax: fl ? fl.fareWithTax : null,
      excluded: fl ? fl.excludedFromCalc : false,
    });
  }
  // 作業日昇順で並べ替え（インデックスは保持）
  const sortedIdx = input.records
    .map((_, i) => i)
    .sort((a, b) => input.records[a].workDay - input.records[b].workDay);

  for (const i of sortedIdx) {
    const r = input.records[i];
    const fl = lineFareMap.get(i);
    aoa.push([
      r.workDay,
      r.dayOfWeek,
      r.taskName,
      r.pickupLocation,
      r.deliveryLocation,
      r.startTime,
      r.endTime,
      r.distanceKm,
      r.advancePayment,
      fl?.excluded ? '-' : fl?.fareWithTax ?? null,
      r.notes,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // マイナス値の赤字スタイル: finalAmount セル（B12 想定）
  // SheetJS の OSS 版は cell.s のスタイル書き出しに制限があるため、まずは値の前に
  // △ 記号を付けて視認性を確保する補助的表現を行う（design.md の「赤字表示」要件）。
  if (input.result.finalAmount < 0) {
    const addr = XLSX.utils.encode_cell({ r: 11, c: 1 });
    const cell = (ws as Record<string, XLSX.CellObject>)[addr];
    if (cell) {
      cell.t = 's';
      cell.v = `▲ ${Math.abs(input.result.finalAmount).toLocaleString()}`;
    }
  }
  // 「日」「業務名」等の列幅を調整
  ws['!cols'] = [
    { wch: 4 },
    { wch: 4 },
    { wch: 18 },
    { wch: 14 },
    { wch: 14 },
    { wch: 6 },
    { wch: 6 },
    { wch: 6 },
    { wch: 10 },
    { wch: 14 },
    { wch: 30 },
  ];
  void detailHeaderRowIdx;

  XLSX.utils.book_append_sheet(wb, ws, '支払明細');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf);
}

export function makeFileName(period: string, driverName: string): string {
  const safe = driverName.replace(/[/\\\x00-\x1f"<>:|?*]/g, '_');
  return `${period}_${safe}_支払明細.xlsx`;
}
