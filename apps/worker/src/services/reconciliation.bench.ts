// STEELO Phase 2 F4 bench gate
// 月次照合 1,000 件 × 1,000 件規模で 60 秒以内に完了することを保証。
// Codex Phase 2 review MEDIUM #18 反映。
import { describe, it, expect } from 'vitest';
import { reconcile, type DispatchLike, type ClientLike } from './reconciliation.js';

const TASK_NAMES = [
  '築地チャーター',
  '上野毛チャーター',
  '中村橋チャーター',
  '定期便',
  '距離便',
  '3H便',
  '4H便',
  'マッハ',
  '足立アネックス',
  '台東アネックス',
];

function makeDispatches(n: number): DispatchLike[] {
  const out: DispatchLike[] = [];
  for (let i = 0; i < n; i++) {
    const driver = `d-${i % 20}`;
    const day = (i % 28) + 1;
    out.push({
      id: `dispatch-${i}`,
      driver_id: driver,
      work_date: `2026-05-${String(day).padStart(2, '0')}`,
      task_name: TASK_NAMES[i % TASK_NAMES.length],
      start_time: `0${(i % 8) + 6}:00`.replace(/^0(\d{2})/, '$1'),
      end_time: null,
    });
  }
  return out;
}

function makeClients(n: number): ClientLike[] {
  const out: ClientLike[] = [];
  for (let i = 0; i < n; i++) {
    const driver = i % 25 === 0 ? null : `d-${i % 20}`; // 4% は未紐付け
    const day = (i % 28) + 1;
    // 80% は完全一致、20% は task_name が違う
    const task =
      i % 5 === 0
        ? `${TASK_NAMES[i % TASK_NAMES.length]}-alt`
        : TASK_NAMES[i % TASK_NAMES.length];
    out.push({
      id: `client-${i}`,
      driver_id: driver,
      period: '2026-05',
      work_day: day,
      task_name: task,
      start_time: `0${(i % 8) + 6}:00`.replace(/^0(\d{2})/, '$1'),
      end_time: null,
      fare: 5000 + (i % 50) * 100,
      advance_payment: i % 10 === 0 ? 1000 : 0,
    });
  }
  return out;
}

describe('reconciliation bench gate', () => {
  it('1,000 × 1,000 件で 5 秒以内に完了', () => {
    const dispatches = makeDispatches(1000);
    const clients = makeClients(1000);

    // ウォームアップ
    reconcile({ dispatches: dispatches.slice(0, 50), clientRecords: clients.slice(0, 50) });

    const start = performance.now();
    const { summary } = reconcile({ dispatches, clientRecords: clients });
    const elapsed = performance.now() - start;

    console.log(
      `[bench] reconcile 1000×1000: ${elapsed.toFixed(1)}ms, ` +
        `matched=${summary.matched} client_only=${summary.clientOnly} dispatch_only=${summary.dispatchOnly}`
    );
    expect(elapsed).toBeLessThan(5000); // 60s 目標に対し 12 倍の余裕
    // ある程度の matched が出ること（task_name 完全一致 80% × 紐付け 96%）
    expect(summary.matched).toBeGreaterThan(500);
  });
});
