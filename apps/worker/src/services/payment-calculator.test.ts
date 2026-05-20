import { describe, it, expect } from 'vitest';
import { calculatePayment } from './payment-calculator.js';

const RATES = { commissionRate: 0.075, taxRate: 0.1 };
const NO_DEDUCTIONS = { vehicleCost: 0, processingFee: 0, prepayment: 0 };

describe('calculatePayment - 計算ロジック', () => {
  it('インボイスあり: 7,680円 → 7,104（控除後）→ 7,814（税込・四捨五入）', () => {
    const r = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: NO_DEDUCTIONS,
      records: [{ fare: 7680, advancePayment: 1040 }],
    });
    expect(r.fareLines[0].fareAfterCommission).toBe(7104);
    expect(r.fareLines[0].fareWithTax).toBe(7814);
    expect(r.totalFareWithTax).toBe(7814);
    expect(r.totalAdvance).toBe(1040);
    expect(r.finalAmount).toBe(7814 + 1040);
  });

  it('インボイスなし: 7,680円 → 7,104円（税込=控除後と同じ）', () => {
    const r = calculatePayment({
      driver: { hasInvoice: false },
      rates: RATES,
      deductions: NO_DEDUCTIONS,
      records: [{ fare: 7680, advancePayment: 1040 }],
    });
    expect(r.fareLines[0].fareAfterCommission).toBe(7104);
    expect(r.fareLines[0].fareWithTax).toBe(7104);
    expect(r.finalAmount).toBe(7104 + 1040);
  });

  it('fare=null（同便従属行）は excludedFromCalc=true で残し、totals から除外', () => {
    const r = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: NO_DEDUCTIONS,
      records: [
        { fare: 1000, advancePayment: 0 },
        { fare: null, advancePayment: 100 },
        { fare: 2000, advancePayment: 0 },
      ],
    });
    expect(r.fareLines).toHaveLength(3);
    expect(r.fareLines[1].excludedFromCalc).toBe(true);
    expect(r.fareLines[1].fareWithTax).toBeNull();
    // 立替は除外行でも加算される
    expect(r.totalAdvance).toBe(100);
    expect(r.totalFareWithTax).toBe(
      Math.round(1000 * 0.925 * 1.1) + Math.round(2000 * 0.925 * 1.1)
    );
  });

  it('控除を引いた結果がマイナスでもそのまま返す', () => {
    const r = calculatePayment({
      driver: { hasInvoice: false },
      rates: RATES,
      deductions: { vehicleCost: 50000, processingFee: 1000, prepayment: 0 },
      records: [{ fare: 10000, advancePayment: 0 }],
    });
    expect(r.finalAmount).toBeLessThan(0);
  });

  it('税率を変えるとスナップショットとして反映される（0.08 のケース）', () => {
    const r = calculatePayment({
      driver: { hasInvoice: true },
      rates: { commissionRate: 0.075, taxRate: 0.08 },
      deductions: NO_DEDUCTIONS,
      records: [{ fare: 10000, advancePayment: 0 }],
    });
    // 10000 * 0.925 = 9250; * 1.08 = 9990
    expect(r.fareLines[0].fareWithTax).toBe(9990);
  });

  it('手数料率を変えるとスナップショットとして反映される（0.10 のケース）', () => {
    const r = calculatePayment({
      driver: { hasInvoice: false },
      rates: { commissionRate: 0.1, taxRate: 0.1 },
      deductions: NO_DEDUCTIONS,
      records: [{ fare: 10000, advancePayment: 0 }],
    });
    // 10000 * 0.9 = 9000
    expect(r.fareLines[0].fareAfterCommission).toBe(9000);
  });

  it('行単位丸め vs 合算後丸めの差異が出るケース', () => {
    // インボイスあり、複数の小数発生ケースで行単位丸めの累積を確認
    const r = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: NO_DEDUCTIONS,
      records: [
        { fare: 1234, advancePayment: 0 },
        { fare: 5678, advancePayment: 0 },
        { fare: 91011, advancePayment: 0 },
      ],
    });
    const expected = [
      Math.round(Math.round(1234 * 0.925) > 0 ? 0 : 0),
    ];
    void expected; // suppress unused
    const sum =
      Math.round(1234 * 0.925 * 1.1) +
      Math.round(5678 * 0.925 * 1.1) +
      Math.round(91011 * 0.925 * 1.1);
    expect(r.totalFareWithTax).toBe(sum);
  });

  it('controllRate 範囲外なら throw', () => {
    expect(() =>
      calculatePayment({
        driver: { hasInvoice: true },
        rates: { commissionRate: 1.5, taxRate: 0.1 },
        deductions: NO_DEDUCTIONS,
        records: [],
      })
    ).toThrow(/commissionRate/);
  });

  it('控除のみの計算: records 空でも finalAmount は -控除 になる', () => {
    const r = calculatePayment({
      driver: { hasInvoice: true },
      rates: RATES,
      deductions: { vehicleCost: 1000, processingFee: 500, prepayment: 300 },
      records: [],
    });
    expect(r.totalFareWithTax).toBe(0);
    expect(r.finalAmount).toBe(-1800);
  });
});
