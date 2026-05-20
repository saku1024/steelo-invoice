// STEELO Phase 1 — ルート層の runtime 入力検証ヘルパ。
//
// TypeScript の型は client 側だけの約束で、runtime では body は any。
// 各ルートで同じパターンの検証を繰り返さないよう、共通の小ユーティリティをここに置く。
// Codex impl review MEDIUM #15 反映。

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

export function optString(v: unknown, max = 1000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  return t.length > max ? t.slice(0, max) : t;
}

export function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
  }
  return fallback;
}

/** 非負整数として解釈できなければ null。Excel から JSON 経由で 100.5 等が来うる */
export function asNonNegInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.round(v);
    return n >= 0 ? n : null;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/[,\s]/g, ''));
    if (!Number.isNaN(n) && n >= 0) return Math.round(n);
  }
  return null;
}

export function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/[,\s]/g, ''));
    if (!Number.isNaN(n)) return Math.round(n);
  }
  return null;
}

const HHMM_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
export function asTimeStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  return HHMM_RE.test(t) ? t : null;
}

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
export function asDateStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return YYYY_MM_DD.test(v) ? v : null;
}

const YYYY_MM = /^\d{4}-\d{2}$/;
export function asPeriodStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return YYYY_MM.test(v) ? v : null;
}

/** 1-100 にクランプ（limit 系クエリパラメータ用） */
export function clampLimit(v: unknown, fallback = 50, max = 200): number {
  const n = asNonNegInt(v);
  if (n === null) return fallback;
  if (n <= 0) return fallback;
  return Math.min(n, max);
}

export function clampOffset(v: unknown): number {
  const n = asNonNegInt(v);
  return n === null ? 0 : n;
}
