import { describe, it, expect } from 'vitest';
import {
  detectAnomalies,
  buildBaselineMap,
  buildDispatchCountByDriverDate,
  type AnomalyContext,
  type Baseline,
} from './anomaly-detector.js';

function ctx(opts: Partial<AnomalyContext> = {}): AnomalyContext {
  return {
    baselines: opts.baselines ?? new Map(),
    dispatchCountByDriverDate: opts.dispatchCountByDriverDate ?? new Map(),
    fareDeviationThresholdSigma: opts.fareDeviationThresholdSigma,
  };
}

const baselineTask = (overrides: Partial<Baseline> = {}): Baseline => ({
  driverId: 'd-A',
  taskName: '築地チャーター',
  medianFare: 7500,
  sdFare: 1200,
  sampleSize: 12,
  baselineScope: 'task',
  ...overrides,
});

describe('detectAnomalies / fare_deviation_high', () => {
  it('z-score >= 2 で warning が出る', () => {
    const baselines = buildBaselineMap([baselineTask()]);
    // fare=30000、median=7500、sd=1200 → deviation_sigma = 22500 / 1200 = 18.75
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '築地チャーター',
        start_time: null,
        end_time: null,
        fare: 30000,
        advance_payment: 0,
      },
      context: ctx({ baselines }),
    });
    const w = result.find((r) => r.type === 'fare_deviation_high')!;
    expect(w).toBeDefined();
    expect(w.severity).toBe('warn');
    expect(w.data.deviation_sigma).toBeGreaterThan(2);
    expect(w.data.baseline_scope).toBe('task');
  });

  it('z-score < 2 では warning なし', () => {
    const baselines = buildBaselineMap([baselineTask()]);
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '築地チャーター',
        start_time: null,
        end_time: null,
        fare: 8500, // deviation_sigma = 1000 / 1200 = 0.83
        advance_payment: 0,
      },
      context: ctx({ baselines }),
    });
    expect(result.find((r) => r.type === 'fare_deviation_high')).toBeUndefined();
  });

  it('sd = 0 では warning スキップ (z-score 計算不可)', () => {
    const baselines = buildBaselineMap([baselineTask({ sdFare: 0 })]);
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '築地チャーター',
        start_time: null,
        end_time: null,
        fare: 30000,
        advance_payment: 0,
      },
      context: ctx({ baselines }),
    });
    expect(result.find((r) => r.type === 'fare_deviation_high')).toBeUndefined();
  });

  it('task baseline なし → driver_fallback にフォールバック', () => {
    const baselines = buildBaselineMap([
      baselineTask({ taskName: null, baselineScope: 'driver_fallback' }),
    ]);
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '別の業務',
        start_time: null,
        end_time: null,
        fare: 30000,
        advance_payment: 0,
      },
      context: ctx({ baselines }),
    });
    const w = result.find((r) => r.type === 'fare_deviation_high')!;
    expect(w).toBeDefined();
    expect(w.data.baseline_scope).toBe('driver_fallback');
  });

  it('baseline なし → warning スキップ', () => {
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '築地',
        start_time: null,
        end_time: null,
        fare: 30000,
        advance_payment: 0,
      },
      context: ctx({ baselines: new Map() }),
    });
    expect(result.find((r) => r.type === 'fare_deviation_high')).toBeUndefined();
  });
});

describe('detectAnomalies / time_inversion', () => {
  const clientWith = (start: string | null, end: string | null) => ({
    id: 'c-1',
    driver_id: 'd-A',
    task_name: 'X',
    start_time: start,
    end_time: end,
    fare: null,
    advance_payment: 0,
  });

  it('start <= end は正常 (warning なし)', () => {
    const result = detectAnomalies({
      dispatch: null,
      client: clientWith('06:00', '08:00'),
      context: ctx(),
    });
    expect(result.find((r) => r.type === 'time_inversion')).toBeUndefined();
  });

  it('overnight 距離 <= 720 は overnight 扱い (warning なし)', () => {
    // 23:00 → 02:00 は overnight_distance = (1440-1380)+120 = 180
    const result = detectAnomalies({
      dispatch: null,
      client: clientWith('23:00', '02:00'),
      context: ctx(),
    });
    expect(result.find((r) => r.type === 'time_inversion')).toBeUndefined();
  });

  it('overnight 距離 = 720 は overnight 扱い (境界)', () => {
    // 12:00 → 00:00 は overnight_distance = (1440-720)+0 = 720
    const result = detectAnomalies({
      dispatch: null,
      client: clientWith('12:00', '00:00'),
      context: ctx(),
    });
    expect(result.find((r) => r.type === 'time_inversion')).toBeUndefined();
  });

  it('overnight 距離 > 720 は inversion warning', () => {
    // 11:00 → 00:00 は overnight_distance = (1440-660)+0 = 780 > 720
    const result = detectAnomalies({
      dispatch: null,
      client: clientWith('11:00', '00:00'),
      context: ctx(),
    });
    const w = result.find((r) => r.type === 'time_inversion')!;
    expect(w).toBeDefined();
    expect(w.severity).toBe('warn');
    expect(w.data.source).toBe('client');
    expect(w.data.overnight_distance_min).toBe(780);
  });

  it('parse 失敗 (25:99 等) は skip', () => {
    const result = detectAnomalies({
      dispatch: null,
      client: clientWith('25:99', '08:00'),
      context: ctx(),
    });
    expect(result.find((r) => r.type === 'time_inversion')).toBeUndefined();
  });

  it('dispatch 側でも検出される', () => {
    const result = detectAnomalies({
      dispatch: {
        id: 'd-1',
        driver_id: 'd-A',
        work_date: '2026-05-20',
        task_name: 'X',
        start_time: '10:00',
        end_time: '00:00', // overnight_distance = (1440-600)+0 = 840 > 720
      },
      client: null,
      context: ctx(),
    });
    const w = result.find((r) => r.type === 'time_inversion')!;
    expect(w.data.source).toBe('dispatch');
  });
});

describe('detectAnomalies / advance_payment', () => {
  it('without_dispatch: client.advance_payment > 0 + 未マッチ → info warning', () => {
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: null,
        start_time: null,
        end_time: null,
        fare: 1000,
        advance_payment: 500,
      },
      context: ctx(),
    });
    const w = result.find((r) => r.type === 'advance_payment_without_dispatch')!;
    expect(w).toBeDefined();
    expect(w.severity).toBe('info');
  });

  it('without_label: matched + 立替金あり + ラベルなし → info warning', () => {
    const result = detectAnomalies({
      dispatch: {
        id: 'd-1',
        driver_id: 'd-A',
        work_date: '2026-05-20',
        task_name: '築地チャーター',
        start_time: null,
        end_time: null,
      },
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '築地チャーター',
        start_time: null,
        end_time: null,
        fare: 1000,
        advance_payment: 500,
      },
      context: ctx(),
    });
    expect(result.find((r) => r.type === 'advance_payment_without_label')).toBeDefined();
    expect(result.find((r) => r.type === 'advance_payment_without_dispatch')).toBeUndefined();
  });

  it('without_label: 立替ラベルあり → warning なし', () => {
    const result = detectAnomalies({
      dispatch: {
        id: 'd-1',
        driver_id: 'd-A',
        work_date: '2026-05-20',
        task_name: '立替分 (高速代)',
        start_time: null,
        end_time: null,
      },
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: '立替',
        start_time: null,
        end_time: null,
        fare: 0,
        advance_payment: 5000,
      },
      context: ctx(),
    });
    expect(result.find((r) => r.type === 'advance_payment_without_label')).toBeUndefined();
  });
});

describe('detectAnomalies / dispatch_overload', () => {
  it('同 driver × 同日 3 件以上 → info warning', () => {
    const counts = buildDispatchCountByDriverDate([
      { driver_id: 'd-A', work_date: '2026-05-20' },
      { driver_id: 'd-A', work_date: '2026-05-20' },
      { driver_id: 'd-A', work_date: '2026-05-20' },
    ]);
    const result = detectAnomalies({
      dispatch: {
        id: 'd-1',
        driver_id: 'd-A',
        work_date: '2026-05-20',
        task_name: 'X',
        start_time: null,
        end_time: null,
      },
      client: null,
      context: ctx({ dispatchCountByDriverDate: counts }),
    });
    const w = result.find((r) => r.type === 'dispatch_overload')!;
    expect(w).toBeDefined();
    expect(w.data.dispatch_count).toBe(3);
  });

  it('2 件のみは warning なし', () => {
    const counts = buildDispatchCountByDriverDate([
      { driver_id: 'd-A', work_date: '2026-05-20' },
      { driver_id: 'd-A', work_date: '2026-05-20' },
    ]);
    const result = detectAnomalies({
      dispatch: {
        id: 'd-1',
        driver_id: 'd-A',
        work_date: '2026-05-20',
        task_name: 'X',
        start_time: null,
        end_time: null,
      },
      client: null,
      context: ctx({ dispatchCountByDriverDate: counts }),
    });
    expect(result.find((r) => r.type === 'dispatch_overload')).toBeUndefined();
  });

  it('client_only 行 (dispatch=null) は対象外', () => {
    const counts = buildDispatchCountByDriverDate([
      { driver_id: 'd-A', work_date: '2026-05-20' },
      { driver_id: 'd-A', work_date: '2026-05-20' },
      { driver_id: 'd-A', work_date: '2026-05-20' },
    ]);
    const result = detectAnomalies({
      dispatch: null,
      client: {
        id: 'c-1',
        driver_id: 'd-A',
        task_name: null,
        start_time: null,
        end_time: null,
        fare: null,
        advance_payment: 0,
      },
      context: ctx({ dispatchCountByDriverDate: counts }),
    });
    expect(result.find((r) => r.type === 'dispatch_overload')).toBeUndefined();
  });
});

describe('buildDispatchCountByDriverDate', () => {
  it('複数 driver × 複数日を正しく集計', () => {
    const map = buildDispatchCountByDriverDate([
      { driver_id: 'A', work_date: '2026-05-01' },
      { driver_id: 'A', work_date: '2026-05-01' },
      { driver_id: 'A', work_date: '2026-05-02' },
      { driver_id: 'B', work_date: '2026-05-01' },
    ]);
    expect(map.get('A|2026-05-01')).toBe(2);
    expect(map.get('A|2026-05-02')).toBe(1);
    expect(map.get('B|2026-05-01')).toBe(1);
    expect(map.get('A|2026-05-99')).toBeUndefined();
  });
});
