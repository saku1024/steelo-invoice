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
import { buildCalendarDate } from './date-validation.js';

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
 *
 * Codex Phase 2 review HIGH #10 反映:
 *   client 順序依存の greedy ではなく、全 edge をスコア化してから score 降順で
 *   1 対 1 を確定する「greedy-on-edge」方式に変更。同点は client_record の
 *   作成順（id 昇順）でタイブレーク。
 */
export function reconcile(input: MatchInput): {
  rows: MatchResultRow[];
  summary: MatchSummary;
} {
  const { dispatches, clientRecords } = input;
  const fareDeviationThreshold = input.fareDeviationThreshold ?? 0.5;
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

  // 1. 全 edge を生成（driver_id, date が一致する client × dispatch の組合せのみ）
  interface Edge {
    clientId: string;
    dispatchId: string;
    method: MatchMethod;
    score: number;
  }
  const edges: Edge[] = [];
  const skipClientReason = new Map<string, string>(); // client_only の事前確定用

  for (const cr of clientRecords) {
    if (cr.driver_id === null) {
      skipClientReason.set(cr.id, 'client record has no driver_id');
      continue;
    }
    const dateStr = clientDateString(cr.period, cr.work_day);
    if (!dateStr) {
      skipClientReason.set(cr.id, 'invalid work_day for period');
      continue;
    }
    const candidates = dispatchIndex.get(`${cr.driver_id}|${dateStr}`) ?? [];
    for (const d of candidates) {
      const j = judge(d, cr);
      if (j.score > 0) {
        edges.push({ clientId: cr.id, dispatchId: d.id, method: j.method, score: j.score });
      }
    }
  }

  // 2. score 降順 + (clientId, dispatchId) でタイブレーク（決定論性確保）
  edges.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1;
    return a.dispatchId < b.dispatchId ? -1 : 1;
  });

  // 3. greedy-on-edge: 既に使われた client / dispatch はスキップして 1-1 マッチング
  const dispatchUsed = new Set<string>();
  const clientUsed = new Set<string>();
  const matchedByClient = new Map<string, Edge>();
  for (const e of edges) {
    if (clientUsed.has(e.clientId) || dispatchUsed.has(e.dispatchId)) continue;
    clientUsed.add(e.clientId);
    dispatchUsed.add(e.dispatchId);
    matchedByClient.set(e.clientId, e);
  }

  // 4. 全 client を順に処理 → matched / client_only に振り分け
  const dispatchById = new Map(dispatches.map((d) => [d.id, d]));
  for (const cr of clientRecords) {
    const skip = skipClientReason.get(cr.id);
    if (skip) {
      rows.push({
        dispatchId: null,
        clientRecordId: cr.id,
        matchStatus: 'client_only',
        matchMethod: 'none',
        matchScore: 0,
        warnings: [skip],
      });
      continue;
    }
    const matchedEdge = matchedByClient.get(cr.id);
    const matchedDispatch = matchedEdge ? dispatchById.get(matchedEdge.dispatchId) : undefined;
    const warnings = collectWarnings(cr, matchedDispatch, fareMedianByDriver, fareDeviationThreshold);
    if (matchedEdge) {
      rows.push({
        dispatchId: matchedEdge.dispatchId,
        clientRecordId: cr.id,
        matchStatus: 'matched',
        matchMethod: matchedEdge.method,
        matchScore: matchedEdge.score,
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
    }
  }

  // 5. 未マッチの dispatch を dispatch_only として追加
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
  // Codex Phase 2 review MEDIUM #13: 2026-02-31 のような実在しない日付を弾く
  return buildCalendarDate(period, workDay);
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

/**
 * Codex Phase 2 review MEDIUM #17 反映:
 * 仕様の「dispatch メモがあるのに client.advance_payment=0」は DispatchLike に
 * notes 列が無いため Phase 2 では実装しない。Phase 3 で DispatchLike を拡張して
 * 対応する。Phase 2 では確実に検出できる以下のみ:
 *   - fare_deviation: client.fare が同 driver の中央値から閾値以上乖離
 *   - advance_payment_without_dispatch: 立替金があるが dispatch にマッチしない
 */
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

  // 立替金あるが dispatch にマッチしない
  if (cr.advance_payment > 0 && matchedDispatch === undefined) {
    warnings.push('advance_payment_without_dispatch');
  }

  return warnings;
}
