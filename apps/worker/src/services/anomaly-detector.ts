// STEELO Phase 3 F8: 異常検知ルールエンジン
//
// 5 種類の warning タイプを純粋関数で判定する:
//   - fare_deviation_high: z-score `|fare - median| / sd >= 2`
//   - time_inversion: HH:MM 分単位、overnight 720 分境界
//   - advance_payment_without_dispatch: Phase 2 維持 (立替金 + 未マッチ)
//   - advance_payment_without_label: 立替金あり + matched dispatch だが立替ラベル無し
//   - dispatch_overload: 同 driver × 同日 3 件以上 (precompute 必須)
//
// 純粋関数として実装するため、reconciliation-job が事前に baselines map と
// dispatchCountByDriverDate map を準備して渡す (Codex Phase 3 round 1 HIGH #10)。
import type { StructuredWarning } from '@line-crm/shared';
import { isCalendarValidTime } from './date-validation.js';

// =============================================================================
// 入出力型
// =============================================================================

export interface DispatchLikeForAnomaly {
  id: string;
  driver_id: string;
  work_date: string;       // "YYYY-MM-DD"
  task_name: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface ClientLikeForAnomaly {
  id: string;
  driver_id: string | null;
  task_name: string | null;
  start_time: string | null;
  end_time: string | null;
  fare: number | null;
  advance_payment: number;
}

export interface Baseline {
  driverId: string;
  /** null = driver 全体フォールバック */
  taskName: string | null;
  medianFare: number;
  sdFare: number;
  sampleSize: number;
  baselineScope: 'task' | 'driver_fallback';
}

export interface AnomalyContext {
  /** key: `${driverId}|${taskName ?? '_ALL_'}` */
  baselines: Map<string, Baseline>;
  /** key: `${driverId}|${YYYY-MM-DD}` */
  dispatchCountByDriverDate: Map<string, number>;
  /** z-score threshold (default 2.0) */
  fareDeviationThresholdSigma?: number;
}

export interface AnomalyInput {
  dispatch: DispatchLikeForAnomaly | null;
  client: ClientLikeForAnomaly | null;
  context: AnomalyContext;
}

// =============================================================================
// メイン
// =============================================================================

/** 1 reconciliation 行に対する構造化 warnings を返す純粋関数 */
export function detectAnomalies(input: AnomalyInput): StructuredWarning[] {
  const warnings: StructuredWarning[] = [];
  const threshold = input.context.fareDeviationThresholdSigma ?? 2.0;

  // fare_deviation_high: client_record の fare をベースラインと比較
  const fareDeviation = checkFareDeviation(input.client, input.context, threshold);
  if (fareDeviation) warnings.push(fareDeviation);

  // time_inversion: dispatch / client の start/end が論理的に inversion
  // (両方チェックして両方該当すれば 2 件出す。実運用ではほぼ片方)
  const dispatchTimeInv = checkTimeInversion(
    'dispatch',
    input.dispatch?.start_time ?? null,
    input.dispatch?.end_time ?? null,
  );
  if (dispatchTimeInv) warnings.push(dispatchTimeInv);
  const clientTimeInv = checkTimeInversion(
    'client',
    input.client?.start_time ?? null,
    input.client?.end_time ?? null,
  );
  if (clientTimeInv) warnings.push(clientTimeInv);

  // advance_payment_without_dispatch: Phase 2 維持
  const apwoDispatch = checkAdvancePaymentWithoutDispatch(input);
  if (apwoDispatch) warnings.push(apwoDispatch);

  // advance_payment_without_label: matched だが立替ラベル無し
  const apwoLabel = checkAdvancePaymentWithoutLabel(input);
  if (apwoLabel) warnings.push(apwoLabel);

  // dispatch_overload: 同 driver × 同日 3 件以上
  const overload = checkDispatchOverload(input);
  if (overload) warnings.push(overload);

  return warnings;
}

// =============================================================================
// fare_deviation_high
// =============================================================================

function checkFareDeviation(
  client: ClientLikeForAnomaly | null,
  context: AnomalyContext,
  thresholdSigma: number,
): StructuredWarning | null {
  if (!client || client.driver_id === null || client.fare === null) return null;

  // 優先順位: task baseline → driver_fallback baseline → スキップ
  const taskKey = `${client.driver_id}|${client.task_name ?? '_ALL_'}`;
  const fallbackKey = `${client.driver_id}|_ALL_`;
  const baseline =
    context.baselines.get(taskKey) ?? context.baselines.get(fallbackKey) ?? null;
  if (!baseline) return null;

  // SD = 0 はサンプルが全件同額なので判定スキップ (z-score 計算不可)
  if (baseline.sdFare <= 0) return null;

  const deviation = Math.abs(client.fare - baseline.medianFare) / baseline.sdFare;
  if (deviation < thresholdSigma) return null;

  const dir = client.fare > baseline.medianFare ? '+' : '-';
  return {
    type: 'fare_deviation_high',
    severity: 'warn',
    message: `運賃 ${client.fare.toLocaleString()} 円 (中央値 ${baseline.medianFare.toLocaleString()} 円から ${dir}${deviation.toFixed(2)}σ 乖離)`,
    data: {
      fare: client.fare,
      median_fare: baseline.medianFare,
      sd_fare: baseline.sdFare,
      sample_size: baseline.sampleSize,
      baseline_scope: baseline.baselineScope,
      deviation_sigma: deviation,
      threshold_sigma: thresholdSigma,
    },
  };
}

// =============================================================================
// time_inversion
// =============================================================================

/**
 * Codex Phase 3 round 1 HIGH #11 / round 2 HIGH #3 反映:
 *   start_time > end_time の場合、overnight 距離 ((1440 - start) + end) で判定
 *   - overnight_distance <= 720 → overnight (warning なし)
 *   - overnight_distance > 720 → time_inversion warning
 *   - 720 は overnight 側に含む (例: 12:00 → 00:00 は overnight)
 */
function checkTimeInversion(
  source: 'dispatch' | 'client',
  startTime: string | null,
  endTime: string | null,
): StructuredWarning | null {
  if (!startTime || !endTime) return null;
  if (!isCalendarValidTime(startTime) || !isCalendarValidTime(endTime)) return null;

  const startMin = parseTimeToMinutes(startTime);
  const endMin = parseTimeToMinutes(endTime);
  if (startMin === null || endMin === null) return null;
  if (startMin <= endMin) return null; // 正常

  const overnightDistance = 1440 - startMin + endMin;
  if (overnightDistance <= 720) return null; // overnight 扱い

  return {
    type: 'time_inversion',
    severity: 'warn',
    message: `${source} で時刻矛盾: ${startTime} → ${endTime}`,
    data: {
      source,
      start_time: startTime,
      end_time: endTime,
      overnight_distance_min: overnightDistance,
    },
  };
}

function parseTimeToMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

// =============================================================================
// advance_payment_without_dispatch (Phase 2 維持)
// =============================================================================

function checkAdvancePaymentWithoutDispatch(
  input: AnomalyInput,
): StructuredWarning | null {
  if (!input.client || input.client.advance_payment <= 0) return null;
  if (input.dispatch !== null) return null; // matched なら別ルール側で判定
  return {
    type: 'advance_payment_without_dispatch',
    severity: 'info',
    message: `立替金 ${input.client.advance_payment.toLocaleString()} 円があるが dispatch にマッチしない`,
    data: {
      advance_payment: input.client.advance_payment,
    },
  };
}

// =============================================================================
// advance_payment_without_label
// =============================================================================

const ADVANCE_LABEL_KEYWORDS = ['立替', '実費', '立て替え', '立替金'];

function checkAdvancePaymentWithoutLabel(
  input: AnomalyInput,
): StructuredWarning | null {
  if (!input.client || input.client.advance_payment <= 0) return null;
  if (input.dispatch === null) return null; // 未マッチは without_dispatch 側で
  const taskName = input.dispatch.task_name ?? '';
  const hasLabel = ADVANCE_LABEL_KEYWORDS.some((kw) => taskName.includes(kw));
  if (hasLabel) return null;
  return {
    type: 'advance_payment_without_label',
    severity: 'info',
    message: `立替金 ${input.client.advance_payment.toLocaleString()} 円があるが dispatch.task_name に立替ラベルなし`,
    data: {
      advance_payment: input.client.advance_payment,
      task_name: taskName || null,
    },
  };
}

// =============================================================================
// dispatch_overload
// =============================================================================

function checkDispatchOverload(input: AnomalyInput): StructuredWarning | null {
  if (!input.dispatch) return null; // dispatch_only / matched 行のみ対象
  const key = `${input.dispatch.driver_id}|${input.dispatch.work_date}`;
  const count = input.context.dispatchCountByDriverDate.get(key) ?? 0;
  if (count < 3) return null;
  return {
    type: 'dispatch_overload',
    severity: 'info',
    message: `同 driver × 同日に dispatch ${count} 件 (3 件以上)`,
    data: {
      driver_id: input.dispatch.driver_id,
      work_date: input.dispatch.work_date,
      dispatch_count: count,
    },
  };
}

// =============================================================================
// helpers
// =============================================================================

/** dispatch_records 配列から (driver_id, work_date) ごとの件数 Map を作る */
export function buildDispatchCountByDriverDate(
  dispatches: ReadonlyArray<{ driver_id: string; work_date: string }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of dispatches) {
    const key = `${d.driver_id}|${d.work_date}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** Baseline 配列から (driver_id, task_name?) Map を作る */
export function buildBaselineMap(
  baselines: ReadonlyArray<Baseline>,
): Map<string, Baseline> {
  const m = new Map<string, Baseline>();
  for (const b of baselines) {
    const key = `${b.driverId}|${b.taskName ?? '_ALL_'}`;
    m.set(key, b);
  }
  return m;
}
