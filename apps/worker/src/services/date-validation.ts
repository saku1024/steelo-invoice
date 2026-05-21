// STEELO Phase 2 共通: カレンダー妥当性を含む日付・時刻バリデーション。
// Codex Phase 2 review MEDIUM #13 反映: 2026-02-31 / 25:99 を弾く。

/** YYYY-MM-DD かつ実在する日付なら true */
export function isCalendarValidDate(s: string | null | undefined): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** HH:MM または HH:MM:SS の論理的に妥当な時刻なら true */
export function isCalendarValidTime(s: string | null | undefined): s is string {
  if (typeof s !== 'string') return false;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] ? Number(m[3]) : 0;
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59;
}

/** YYYY-MM プレフィックス + 1-31 で実在するなら "YYYY-MM-DD" 文字列を返す */
export function buildCalendarDate(period: string, workDay: number): string | null {
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  if (!Number.isInteger(workDay) || workDay < 1 || workDay > 31) return null;
  const candidate = `${period}-${String(workDay).padStart(2, '0')}`;
  return isCalendarValidDate(candidate) ? candidate : null;
}
