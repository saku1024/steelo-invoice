import { describe, it, expect } from 'vitest';
import { parseWarnings, serializeWarnings } from './parse-warnings.js';

describe('parseWarnings', () => {
  it('null / 空文字 → []', () => {
    expect(parseWarnings(null)).toEqual([]);
    expect(parseWarnings('')).toEqual([]);
    expect(parseWarnings(undefined)).toEqual([]);
  });

  it('不正 JSON → []', () => {
    expect(parseWarnings('not a json')).toEqual([]);
    expect(parseWarnings('{')).toEqual([]);
  });

  it('JSON だが配列でない → []', () => {
    expect(parseWarnings('{"foo": "bar"}')).toEqual([]);
    expect(parseWarnings('42')).toEqual([]);
  });

  it('Phase 2 旧 string warning (fare_deviation) を fare_deviation_high にマップ', () => {
    const result = parseWarnings(
      JSON.stringify(['fare_deviation: fare=30000, median=7500, deviation=300%']),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('fare_deviation_high');
    expect(result[0].severity).toBe('warn');
    expect(result[0].data.legacy_string).toContain('fare_deviation');
  });

  it('Phase 2 旧 string warning (advance_payment_without_dispatch) をマップ', () => {
    const result = parseWarnings(JSON.stringify(['advance_payment_without_dispatch']));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('advance_payment_without_dispatch');
    expect(result[0].severity).toBe('info');
  });

  it('未知の旧 string warning は legacy_warning にフォールバック', () => {
    const result = parseWarnings(JSON.stringify(['some_unknown_warning']));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('legacy_warning');
    expect(result[0].severity).toBe('info');
  });

  it('新 StructuredWarning[] はそのまま正規化して返す', () => {
    const result = parseWarnings(
      JSON.stringify([
        {
          type: 'time_inversion',
          severity: 'warn',
          message: '時刻矛盾',
          data: { start: '23:00', end: '11:00' },
        },
      ]),
    );
    expect(result[0].type).toBe('time_inversion');
    expect(result[0].severity).toBe('warn');
    expect(result[0].data.start).toBe('23:00');
  });

  it('severity が不正な場合は info にフォールバック', () => {
    const result = parseWarnings(
      JSON.stringify([{ type: 'time_inversion', severity: 'bogus', message: 'x' }]),
    );
    expect(result[0].severity).toBe('info');
  });

  it('新旧混在を許容する', () => {
    const result = parseWarnings(
      JSON.stringify([
        'fare_deviation: foo',
        { type: 'time_inversion', severity: 'warn', message: 'x', data: {} },
      ]),
    );
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fare_deviation_high');
    expect(result[1].type).toBe('time_inversion');
  });
});

describe('serializeWarnings', () => {
  it('空配列は null を返す', () => {
    expect(serializeWarnings([])).toBeNull();
  });

  it('StructuredWarning[] を JSON 文字列に', () => {
    const json = serializeWarnings([
      { type: 'time_inversion', severity: 'warn', message: 'x', data: {} },
    ]);
    expect(json).toBeTruthy();
    expect(JSON.parse(json!)[0].type).toBe('time_inversion');
  });
});
