import { describe, it, expect } from 'vitest';
import {
  reconcile,
  normalizeTaskName,
  levenshteinLE,
  type DispatchLike,
  type ClientLike,
} from './reconciliation.js';

const baseDispatch = (id: string, opts: Partial<DispatchLike> = {}): DispatchLike => ({
  id,
  driver_id: 'd-A',
  work_date: '2026-05-01',
  task_name: '築地チャーター',
  start_time: '06:00',
  end_time: '08:00',
  ...opts,
});

const baseClient = (id: string, opts: Partial<ClientLike> = {}): ClientLike => ({
  id,
  driver_id: 'd-A',
  period: '2026-05',
  work_day: 1,
  task_name: '築地チャーター',
  start_time: '06:00',
  end_time: '08:00',
  fare: 7680,
  advance_payment: 0,
  ...opts,
});

describe('normalizeTaskName', () => {
  it('空白を除去し、半角/全角ハイフンを統一', () => {
    expect(normalizeTaskName('築地 チャーター')).toBe('築地ちゃーたー');
    expect(normalizeTaskName('A‐B')).toBe('a-b'); // U+2010 → 半角
    expect(normalizeTaskName('A-B')).toBe('a-b'); // 半角はそのまま
    expect(normalizeTaskName('築地ー')).toBe('築地ー'); // 長音は保持
    expect(normalizeTaskName(null)).toBe('');
  });
});

describe('levenshteinLE', () => {
  it('閾値以内は true', () => {
    expect(levenshteinLE('築地', '築地', 2)).toBe(true);
    expect(levenshteinLE('築地', '築字', 2)).toBe(true);
    expect(levenshteinLE('AB', 'ABC', 1)).toBe(true);
  });
  it('閾値超過は false', () => {
    expect(levenshteinLE('AB', 'XYZ', 1)).toBe(false);
    expect(levenshteinLE('短い', 'まったくちがう', 2)).toBe(false);
  });
  it('空文字を扱える', () => {
    expect(levenshteinLE('', '', 0)).toBe(true);
    expect(levenshteinLE('', 'a', 1)).toBe(true);
    expect(levenshteinLE('', 'ab', 1)).toBe(false);
  });
});

describe('reconcile', () => {
  it('1 対 1 の strong match', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1')],
      clientRecords: [baseClient('c-1')],
    });
    expect(r.summary).toEqual({ matched: 1, clientOnly: 0, dispatchOnly: 0 });
    expect(r.rows[0].matchStatus).toBe('matched');
    expect(r.rows[0].matchMethod).toBe('strong');
    expect(r.rows[0].matchScore).toBe(1);
  });

  it('カナ→ひらがな統一による strong match', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { task_name: 'ツキジチャーター' })],
      clientRecords: [baseClient('c-1', { task_name: 'つきじちゃーたー' })],
    });
    expect(r.rows[0].matchStatus).toBe('matched');
    expect(r.rows[0].matchMethod).toBe('strong');
    expect(r.rows[0].matchScore).toBe(1);
  });

  it('1-2 字違いは fuzzy match (score=0.7)', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { task_name: '築地チャーター' })],
      // 字面が 1 字違うが Levenshtein 距離 ≤ 2
      clientRecords: [baseClient('c-1', { task_name: '築字チャーター' })],
    });
    expect(r.rows[0].matchStatus).toBe('matched');
    expect(r.rows[0].matchMethod).toBe('fuzzy');
    expect(r.rows[0].matchScore).toBe(0.7);
  });

  it('業務名違うが時刻 ±30 分以内なら time match (score=0.5)', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { task_name: '別業務', start_time: '06:00' })],
      clientRecords: [baseClient('c-1', { task_name: '築地', start_time: '06:20' })],
    });
    expect(r.rows[0].matchStatus).toBe('matched');
    expect(r.rows[0].matchMethod).toBe('time');
    expect(r.rows[0].matchScore).toBe(0.5);
  });

  it('完全不一致は client_only と dispatch_only にそれぞれ振り分け', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { task_name: 'AAA', start_time: '06:00' })],
      clientRecords: [
        baseClient('c-1', { task_name: 'BBB', start_time: '23:00' }),
      ],
    });
    expect(r.summary).toEqual({ matched: 0, clientOnly: 1, dispatchOnly: 1 });
  });

  it('driver_id 違いはマッチしない', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { driver_id: 'd-A' })],
      clientRecords: [baseClient('c-1', { driver_id: 'd-B' })],
    });
    expect(r.summary.matched).toBe(0);
    expect(r.summary.clientOnly).toBe(1);
    expect(r.summary.dispatchOnly).toBe(1);
  });

  it('日付違いはマッチしない', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { work_date: '2026-05-01' })],
      clientRecords: [baseClient('c-1', { work_day: 2 })],
    });
    expect(r.summary.matched).toBe(0);
  });

  it('1 対 N: dispatch を再利用しない（最良スコアのみ採用）', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1')],
      clientRecords: [
        baseClient('c-1', { task_name: '築地チャーター' }),
        baseClient('c-2', { task_name: '築地チャーター' }),
      ],
    });
    // c-1 にマッチし、c-2 は client_only として残る
    expect(r.summary.matched).toBe(1);
    expect(r.summary.clientOnly).toBe(1);
  });

  it('greedy-on-edge: 順序に関わらず score が高い strong > fuzzy > time の順でマッチ', () => {
    // fuzzy client が先、strong client が後 → 旧 greedy は fuzzy にマッチして
    // strong が client_only になっていた。新 greedy-on-edge は strong を優先。
    const r = reconcile({
      dispatches: [baseDispatch('d-1', { task_name: '築地チャーター' })],
      clientRecords: [
        baseClient('c-fuzzy', { task_name: '築字チャーター' }), // fuzzy (0.7)
        baseClient('c-strong', { task_name: '築地チャーター' }), // strong (1.0)
      ],
    });
    expect(r.summary.matched).toBe(1);
    const matched = r.rows.find((row) => row.matchStatus === 'matched')!;
    expect(matched.clientRecordId).toBe('c-strong');
    expect(matched.matchMethod).toBe('strong');
    const clientOnly = r.rows.find((row) => row.matchStatus === 'client_only')!;
    expect(clientOnly.clientRecordId).toBe('c-fuzzy');
  });

  it('greedy-on-edge: 同 score は (clientId, dispatchId) 順で決定論的', () => {
    const r1 = reconcile({
      dispatches: [
        baseDispatch('d-A', { task_name: '築地' }),
        baseDispatch('d-B', { task_name: '築地' }),
      ],
      clientRecords: [
        baseClient('c-1', { task_name: '築地' }),
        baseClient('c-2', { task_name: '築地' }),
      ],
    });
    // 全 edge が strong=1.0、id 昇順タイブレークで (c-1, d-A) と (c-2, d-B)
    const matched = r1.rows.filter((row) => row.matchStatus === 'matched');
    expect(matched).toHaveLength(2);
    const c1 = matched.find((m) => m.clientRecordId === 'c-1')!;
    const c2 = matched.find((m) => m.clientRecordId === 'c-2')!;
    expect(c1.dispatchId).toBe('d-A');
    expect(c2.dispatchId).toBe('d-B');
  });

  it('client.driver_id が null なら client_only', () => {
    const r = reconcile({
      dispatches: [baseDispatch('d-1')],
      clientRecords: [baseClient('c-1', { driver_id: null })],
    });
    const co = r.rows.find((row) => row.matchStatus === 'client_only')!;
    expect(co.warnings).toContain('client record has no driver_id');
    expect(r.summary.dispatchOnly).toBe(1);
  });

  it('運賃が中央値から 50% 以上乖離していたら fare_deviation warning', () => {
    const r = reconcile({
      dispatches: [
        baseDispatch('d-1', { work_date: '2026-05-01' }),
        baseDispatch('d-2', { work_date: '2026-05-02' }),
        baseDispatch('d-3', { work_date: '2026-05-03' }),
      ],
      clientRecords: [
        baseClient('c-1', { work_day: 1, fare: 7000 }),
        baseClient('c-2', { work_day: 2, fare: 7500 }),
        baseClient('c-3', { work_day: 3, fare: 30000 }), // 異常値
      ],
    });
    const c3 = r.rows.find((row) => row.clientRecordId === 'c-3')!;
    expect(c3.warnings.some((w) => w.startsWith('fare_deviation:'))).toBe(true);
  });

  it('invalid work_day は client_only にして warning', () => {
    const r = reconcile({
      dispatches: [],
      clientRecords: [baseClient('c-1', { work_day: 99 })],
    });
    expect(r.rows[0].matchStatus).toBe('client_only');
    expect(r.rows[0].warnings).toContain('invalid work_day for period');
  });
});
