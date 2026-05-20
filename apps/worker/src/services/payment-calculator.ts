// STEELO Phase 1 F6: 単一ドライバーの月次支払額を決定論的に計算する純粋関数。
//
// 計算ルール（design.md F6-a, requirements.md Req 5 参照）:
//   1. fare = NULL の行は計算から除外（excludedFromCalc=true で残す）
//   2. 行単位で「手数料控除 → 消費税適用 → Math.round() で円単位四捨五入」を実施
//      （合算後丸めは累積誤差が出るため不可）
//   3. 控除（車両代/電算処理費/前払金）は per-driver per-period の値を呼び出し側で
//      集めて渡す。batch ヘッダー（会社合計）は使わない。
//   4. 最終支払額 = Σ(行単位の運賃税込) + Σ(立替) - 控除三種
//   5. マイナスでもそのまま返す（赤字表示は出力側の責務）
import type { PaymentInput, PaymentResult, PaymentFareLine } from '@line-crm/shared';

export function calculatePayment(input: PaymentInput): PaymentResult {
  const { driver, rates, deductions, records } = input;
  if (rates.commissionRate < 0 || rates.commissionRate >= 1) {
    throw new Error(`commissionRate out of range: ${rates.commissionRate}`);
  }
  if (rates.taxRate < 0 || rates.taxRate >= 1) {
    throw new Error(`taxRate out of range: ${rates.taxRate}`);
  }

  const lines: PaymentFareLine[] = [];
  let totalFareBeforeTax = 0;
  let totalFareWithTax = 0;
  let totalAdvance = 0;

  for (const r of records) {
    totalAdvance += r.advancePayment;
    if (r.fare === null) {
      lines.push({
        fareAfterCommission: null,
        fareWithTax: null,
        advance: r.advancePayment,
        excludedFromCalc: true,
      });
      continue;
    }
    // 手数料控除後（税抜、行ごとには整数化しないが、最終的に税込で四捨五入する）
    const afterCommission = r.fare * (1 - rates.commissionRate);
    const withTax = driver.hasInvoice
      ? afterCommission * (1 + rates.taxRate)
      : afterCommission;
    // 行単位で円単位四捨五入
    const afterCommissionRounded = Math.round(afterCommission);
    const withTaxRounded = Math.round(withTax);
    totalFareBeforeTax += afterCommissionRounded;
    totalFareWithTax += withTaxRounded;
    lines.push({
      fareAfterCommission: afterCommissionRounded,
      fareWithTax: withTaxRounded,
      advance: r.advancePayment,
      excludedFromCalc: false,
    });
  }

  const finalAmount =
    totalFareWithTax +
    totalAdvance -
    deductions.vehicleCost -
    deductions.processingFee -
    deductions.prepayment;

  return {
    fareLines: lines,
    totalFareBeforeTax,
    totalFareWithTax,
    totalAdvance,
    vehicleCost: deductions.vehicleCost,
    processingFee: deductions.processingFee,
    prepayment: deductions.prepayment,
    finalAmount,
  };
}
