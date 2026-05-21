// STEELO Phase 3: reconciliations.warnings の構造化変換ヘルパ
//
// Phase 2 は warnings を string[] で保存していた:
//   ["fare_deviation: fare=30000, median=7500, deviation=300%",
//    "advance_payment_without_dispatch"]
//
// Phase 3 は構造化 StructuredWarning[] で保存する:
//   [{type, severity, message, data}, ...]
//
// reconciliations テーブルの warnings カラムは TEXT のまま変更しないが、
// 中身が新旧混在するため、読み出し時はこのヘルパで一律 StructuredWarning[] に
// 正規化する。これにより:
//  - 旧 Phase 2 データを再計算しなくても新 UI / PDF / Slack で読める
//  - 段階的な structured 化が可能 (新規 INSERT のみ structured で書く)
//
// Codex Phase 3 review CRITICAL #2 反映。
import type {
  StructuredWarning,
  WarningSeverity,
  WarningType,
} from '@line-crm/shared';

/** 旧 string warning の prefix → 新 type への mapping */
const LEGACY_PREFIX_MAP: Array<{
  pattern: RegExp;
  type: WarningType;
  severity: WarningSeverity;
}> = [
  { pattern: /^fare_deviation:/, type: 'fare_deviation_high', severity: 'warn' },
  {
    pattern: /^advance_payment_without_dispatch$/,
    type: 'advance_payment_without_dispatch',
    severity: 'info',
  },
  { pattern: /^client record has no driver_id$/, type: 'legacy_warning', severity: 'info' },
  { pattern: /^invalid work_day for period$/, type: 'legacy_warning', severity: 'info' },
];

/**
 * reconciliations.warnings (TEXT JSON 配列) を構造化配列に正規化する。
 *
 * - null / 空文字 → []
 * - 旧 string[] → 各要素を legacy_warning か mapped type に変換
 * - 新 StructuredWarning[] → validate して返す
 * - 不正 JSON → [] + console.warn
 */
export function parseWarnings(raw: string | null | undefined): StructuredWarning[] {
  if (!raw || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('[parseWarnings] invalid JSON, treating as empty:', e);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const result: StructuredWarning[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      // 旧 string warning
      result.push(convertLegacyString(item));
    } else if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { type?: unknown }).type === 'string'
    ) {
      // 新 StructuredWarning
      const w = item as Record<string, unknown>;
      result.push({
        type: (w.type as WarningType) ?? 'legacy_warning',
        severity: ((w.severity as WarningSeverity) === 'warn'
          ? 'warn'
          : 'info') as WarningSeverity,
        message: typeof w.message === 'string' ? w.message : '',
        data:
          typeof w.data === 'object' && w.data !== null
            ? (w.data as Record<string, unknown>)
            : {},
      });
    }
    // それ以外は捨てる (null, number 等)
  }
  return result;
}

/**
 * StructuredWarning[] を JSON 文字列にシリアライズする。
 * 空配列は null を返して NULL として保存する (Phase 2 と同じ挙動)。
 */
export function serializeWarnings(warnings: StructuredWarning[]): string | null {
  if (warnings.length === 0) return null;
  return JSON.stringify(warnings);
}

function convertLegacyString(legacy: string): StructuredWarning {
  for (const map of LEGACY_PREFIX_MAP) {
    if (map.pattern.test(legacy)) {
      return {
        type: map.type,
        severity: map.severity,
        message: legacy,
        data: { legacy_string: legacy },
      };
    }
  }
  // mapping に該当しない旧文字列は legacy_warning として保持
  return {
    type: 'legacy_warning',
    severity: 'info',
    message: legacy,
    data: { legacy_string: legacy },
  };
}
