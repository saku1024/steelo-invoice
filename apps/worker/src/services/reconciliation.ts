// STEELO Phase 2 F4: dispatch_records × client_records の照合エンジン。
//
// 純粋関数として実装。月次照合ジョブ (reconciliation-job.ts) から呼ばれる。
//
// アルゴリズム:
//   1. dispatch を (driver_id, work_date) でインデックス化
//   2. client_record の period + work_day から仮想日付を組み立てて driver_id, date で
//      strong/fuzzy/time 候補を探す
//   3. 最良スコアでマッチを決め、残った dispatch を dispatch_only、
//      残った client を client_only として記録
import type { MatchMethod, MatchStatus } from '@line-crm/shared';

export interface DispatchLike {
  id: string;
  driver_id: string;
  work_date: string; // "YYYY-MM-DD"
  task_name: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface ClientLike {
  id: string;
  driver_id: string | null;
  period: string; // "YYYY-MM"
  work_day: number; // 1-31
  task_name: string | null;
  start_time: string | null;
  end_time: string | null;
  fare: number | null;
  advance_payment: number;
}

export interface MatchResultRow {
  dispatchId: string | null;
  clientRecordId: string | null;
  matchStatus: MatchStatus;
  matchMethod: MatchMethod;
  matchScore: number;
  warnings: string[];
}

export interface MatchInput {
  dispatches: DispatchLike[];
  clientRecords: ClientLike[];
  /** 警告閾値: 同 driver の運賃中央値からどれだけ乖離したら warning にするか */
  fareDeviationThreshold?: number; // 0.5 = 50%
}

export interface MatchSummary {
  matched: number;
  clientOnly: number;
  dispatchOnly: number;
}

const SCORE_STRONG = 1.0;
const SCORE_FUZZY = 0.7;
const SCORE_TIME = 0.5;

/**
 * 月次照合のメインエントリ。dispatch + client の組合せを 3 分類に分けた行配列を返す。
 * 同じ dispatch / client が複数行に出ない（1 対 1 マッチを保証）。
 */
export function reconcile(input: MatchInput): {
  rows: MatchResultRow[];
  summary: MatchSummary;
} {
  const { dispatches, clientRecords } = input;
  const fareDeviationThreshold = input.fareDeviationThreshold ?? 0.5;

  const dispatchUsed = new Set<string>();
  const clientUsed = new Set<string>();
  const rows: MatchResultRow[] = [];

  // 同 driver の運賃中央値（warnings 用）
  const fareMedianByDriver = computeFareMedianByDriver(clientRecords);

  // dispatch を (driver_id, work_date) で索引
  const dispatchIndex = new Map<string, DispatchLike[]>();
  for (const d of dispatches) {
    const key = `${d.driver_id}|${d.work_date}`;
    const arr = dispatchIndex.get(key);
    if (arr) arr.push(d);
    else dispatchIndex.set(key, [d]);
  }

  // client_records を順に処理してマッチを探す
  for (const cr of clientRecords) {
    if (cr.driver_id === null) {
      // 未紐付け client は client_only として記録
      rows.push({
        dispatchId: null,
        clientRecordId: cr.id,
        matchStatus: 'client_only',
        matchMethod: 'none',
        matchScore: 0,
        warnings: ['client record has no driver_id'],
      });
      clientUsed.add(cr.id);
      continue;
    }

    const dateStr = clientDateString(cr.period, cr.work_day);
    if (!dateStr) {
      rows.push({
        dispatchId: null,
        clientRecordId: cr.id,
        matchStatus: 'client_only',
        matchMethod: 'none',
        matchScore: 0,
        warnings: ['invalid work_day for period'],
      });
      clientUsed.add(cr.id);
      continue;
    }

    const candidates =
      dispatchIndex.get(`${cr.driver_id}|${dateStr}`)?.filter((d) => !dispatchUsed.has(d.id)) ??
      [];

    let best: { dispatch: DispatchLike; method: MatchMethod; score: number } | null = null;
    for (const d of candidates) {
      const judgement = judge(d, cr);
      if (!best || judgement.score > best.score) {
        best = { dispatch: d, ...judgement };
      }
    }

    const warnings = collectWarnings(cr, best?.dispatch, fareMedianByDriver, fareDeviationThreshold);

    if (best && best.score > 0) {
      dispatchUsed.add(best.dispatch.id);
      clientUsed.add(cr.id);
      rows.push({
        dispatchId: best.dispatch.id,
        clientRecordId: cr.id,
        matchStatus: 'matched',
        matchMethod: best.method,
        matchScore: best.score,
        warnings,
      });
    } else {
      rows.push({
        dispatchId: null,
        clientRecordId: cr.id,
        matchStatus: 'client_only',
        matchMethod: 'none',
        matchScore: 0,
        warnings,
      });
      clientUsed.add(cr.id);
    }
  }

  // 未マッチの dispatch を dispatch_only として追加
  for (const d of dispatches) {
    if (!dispatchUsed.has(d.id)) {
      rows.push({
        dispatchId: d.id,
        clientRecordId: null,
        matchStatus: 'dispatch_only',
        matchMethod: 'none',
        matchScore: 0,
        warnings: [],
      });
    }
  }

  const summary: MatchSummary = {
    matched: rows.filter((r) => r.matchStatus === 'matched').length,
    clientOnly: rows.filter((r) => r.matchStatus === 'client_only').length,
    dispatchOnly: rows.filter((r) => r.matchStatus === 'dispatch_only').length,
  };
  return { rows, summary };
}

// =============================================================================
// マッチング判定
// =============================================================================

function judge(d: DispatchLike, c: ClientLike): { method: MatchMethod; score: number } {
  const dTask = normalizeTaskName(d.task_name);
  const cTask = normalizeTaskName(c.task_name);

  if (dTask && cTask) {
    if (dTask === cTask) return { method: 'strong', score: SCORE_STRONG };
    if (levenshteinLE(dTask, cTask, 2)) return { method: 'fuzzy', score: SCORE_FUZZY };
  }

  // 時刻アシスト: 同日同 driver で start_time が ±30 分以内
  if (d.start_time && c.start_time) {
    const dMin = parseTimeToMinutes(d.start_time);
    const cMin = parseTimeToMinutes(c.start_time);
    if (dMin !== null && cMin !== null && Math.abs(dMin - cMin) <= 30) {
      return { method: 'time', score: SCORE_TIME };
    }
  }
  return { method: 'none', score: 0 };
}

/**
 * タスク名を比較しやすく正規化。空白除去、ハイフン類統一、カタカナ→ひらがな。
 * 「ー」は日本語の長音符号であり半角ハイフンに変換しない（"築地ー" は "築地ー" のまま）。
 */
export function normalizeTaskName(name: string | null): string {
  if (!name) return '';
  let n = name.trim().toLowerCase();
  n = n.replace(/[\s　]+/g, '');
  // 半角・全角ハイフンの種類は統一するが、長音符号「ー」は保持
  n = n.replace(/[‐－―‑]/g, '-');
  // カタカナ→ひらがな（ー は変換対象外）
  n = n.replace(/[ァ-ヶ]/g, (m) =>
    String.fromCharCode(m.charCodeAt(0) - 0x60)
  );
  return n;
}

/**
 * Levenshtein 距離が threshold 以下かどうかを判定する（早期打切り版）。
 * 完全な距離は計算せず、threshold 超過が確定した時点で false を返す。
 */
export function levenshteinLE(a: string, b: string, threshold: number): boolean {
  if (Math.abs(a.length - b.length) > threshold) return false;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m <= threshold;
  if (m === 0) return n <= threshold;
  let prev = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const curr = new Array<number>(m + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > threshold) return false;
    prev = curr;
  }
  return prev[m] <= threshold;
}

function parseTimeToMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function clientDateString(period: string, workDay: number): string | null {
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  if (!Number.isInteger(workDay) || workDay < 1 || workDay > 31) return null;
  return `${period}-${String(workDay).padStart(2, '0')}`;
}

function computeFareMedianByDriver(records: ClientLike[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of records) {
    if (r.driver_id && r.fare !== null) {
      const arr = groups.get(r.driver_id);
      if (arr) arr.push(r.fare);
      else groups.set(r.driver_id, [r.fare]);
    }
  }
  const med = new Map<string, number>();
  for (const [driverId, fares] of groups) {
    if (fares.length === 0) continue;
    const sorted = [...fares].sort((a, b) => a - b);
    med.set(driverId, sorted[Math.floor(sorted.length / 2)]);
  }
  return med;
}

function collectWarnings(
  cr: ClientLike,
  matchedDispatch: DispatchLike | undefined,
  fareMedianByDriver: Map<string, number>,
  threshold: number
): string[] {
  const warnings: string[] = [];

  // 運賃乖離 warning
  if (cr.driver_id && cr.fare !== null) {
    const median = fareMedianByDriver.get(cr.driver_id);
    if (median && median > 0) {
      const deviation = Math.abs(cr.fare - median) / median;
      if (deviation >= threshold) {
        warnings.push(
          `fare_deviation: fare=${cr.fare}, median=${median}, deviation=${(deviation * 100).toFixed(0)}%`
        );
      }
    }
  }

  // 立替金あるが時刻ない etc.
  if (cr.advance_payment > 0 && matchedDispatch === undefined) {
    warnings.push('advance_payment_without_dispatch');
  }

  return warnings;
}
