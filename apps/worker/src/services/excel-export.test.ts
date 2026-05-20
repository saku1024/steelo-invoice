import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDriverExcel, makeFileName } from './excel-export.js';
import { calculatePayment } from './payment-calculator.js';

const RATES = { commissionRate: 0.075, taxRate: 0.1 };
const NO_DED = { vehicleCost: 0, processingFee: 0, prepayment: 0 };

function readBack(bytes: Uint8Array) {
  const wb = XLSX.read(bytes, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null }) as unknown[][];
}

describe('buildDriverExcel', () => {
  it('ヘッダー部に宛名・対象月・合計が反映される', () => {
    const result = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: NO_DED,
      records: [{ fare: 7680, advancePayment: 1040 }],
    });
    const xlsx = buildDriverExcel({
      driver: { name: '田中太郎', hasInvoice: true },
      period: '2026-05',
      records: [
        {
          workDay: 1,
          dayOfWeek: '木',
          taskName: '築地',
          pickupLocation: '東京',
          deliveryLocation: '築地',
          startTime: '06:00',
          endTime: '08:00',
          distanceKm: 15,
          advancePayment: 1040,
          fare: 7680,
          notes: null,
        },
      ],
      result,
    });
    const aoa = readBack(xlsx);
    // 宛名行
    expect(aoa[1][0]).toBe('宛先');
    expect(aoa[1][1]).toBe('田中太郎 様');
    expect(aoa[2][1]).toBe('2026-05');
    // 合計行
    expect(aoa.some((r) => r[0] === 'お支払い金額合計' && r[1] === result.finalAmount)).toBe(true);
  });

  it('明細部に行単位四捨五入後の税込値が入る', () => {
    const result = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: NO_DED,
      records: [{ fare: 7680, advancePayment: 0 }],
    });
    const xlsx = buildDriverExcel({
      driver: { name: 'A', hasInvoice: true },
      period: '2026-05',
      records: [
        {
          workDay: 1,
          dayOfWeek: '木',
          taskName: '築地',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 7680,
          notes: null,
        },
      ],
      result,
    });
    const aoa = readBack(xlsx);
    // 明細ヘッダー行を探す
    const headerIdx = aoa.findIndex((r) => r[0] === '日' && r[9] === '運賃（税込）');
    expect(headerIdx).toBeGreaterThan(0);
    const dataRow = aoa[headerIdx + 1];
    expect(dataRow[9]).toBe(7814); // 7680 * 0.925 * 1.1 = 7814.4 → 7814
  });

  it('同便従属行は「-」で表示され、totals には含まれない', () => {
    const result = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: NO_DED,
      records: [
        { fare: 7680, advancePayment: 0 },
        { fare: null, advancePayment: 0 },
      ],
    });
    const xlsx = buildDriverExcel({
      driver: { name: 'A', hasInvoice: true },
      period: '2026-05',
      records: [
        {
          workDay: 1,
          dayOfWeek: null,
          taskName: '築地',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 7680,
          notes: null,
        },
        {
          workDay: 1,
          dayOfWeek: null,
          taskName: null,
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: null,
          notes: '同便',
        },
      ],
      result,
    });
    const aoa = readBack(xlsx);
    const headerIdx = aoa.findIndex((r) => r[0] === '日');
    // 2行分の明細
    const r1 = aoa[headerIdx + 1];
    const r2 = aoa[headerIdx + 2];
    expect(r1[9]).toBe(7814);
    expect(r2[9]).toBe('-');
  });

  it('マイナス支払額は数値のまま保持され、注意セルが追加される', () => {
    const result = calculatePayment({
      driver: { hasInvoice: false },
      rates: RATES,
      deductions: { vehicleCost: 100000, processingFee: 0, prepayment: 0 },
      records: [{ fare: 1000, advancePayment: 0 }],
    });
    expect(result.finalAmount).toBeLessThan(0);
    const xlsx = buildDriverExcel({
      driver: { name: 'A', hasInvoice: false },
      period: '2026-05',
      records: [
        {
          workDay: 1,
          dayOfWeek: null,
          taskName: 'T',
          pickupLocation: null,
          deliveryLocation: null,
          startTime: null,
          endTime: null,
          distanceKm: null,
          advancePayment: 0,
          fare: 1000,
          notes: null,
        },
      ],
      result,
    });
    const aoa = readBack(xlsx);
    const finalRow = aoa.find((r) => r[0] === 'お支払い金額合計');
    expect(typeof finalRow![1]).toBe('number');
    expect(finalRow![1]).toBeLessThan(0);
    expect(aoa.some((r) => typeof r[0] === 'string' && /マイナス/.test(r[0]))).toBe(true);
  });
});

describe('makeFileName', () => {
  it('スラッシュ等を _ に変換', () => {
    expect(makeFileName('2026-05', '田中/太郎')).toBe('2026-05_田中_太郎_支払明細.xlsx');
  });
  it('正常な名前はそのまま', () => {
    expect(makeFileName('2026-05', '田中太郎')).toBe('2026-05_田中太郎_支払明細.xlsx');
  });
});
