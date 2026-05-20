import { describe, it, expect } from 'vitest';
import {
  isNonEmptyString,
  optString,
  asBool,
  asNonNegInt,
  asInt,
  asTimeStr,
  asDateStr,
  asPeriodStr,
  clampLimit,
  clampOffset,
} from './validation.js';

describe('isNonEmptyString', () => {
  it('non-empty string で true', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString(' a ')).toBe(true);
  });
  it('空 / 空白のみ / non-string で false', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
  });
});

describe('optString', () => {
  it('null/undefined はそのまま null', () => {
    expect(optString(null)).toBeNull();
    expect(optString(undefined)).toBeNull();
  });
  it('空白文字列は null', () => {
    expect(optString('')).toBeNull();
    expect(optString('   ')).toBeNull();
  });
  it('前後の空白をトリム', () => {
    expect(optString('  hello  ')).toBe('hello');
  });
  it('non-string は null', () => {
    expect(optString(123)).toBeNull();
    expect(optString(true)).toBeNull();
  });
  it('max 文字数でクランプ', () => {
    expect(optString('aaaaa', 3)).toBe('aaa');
  });
});

describe('asBool', () => {
  it('boolean はそのまま', () => {
    expect(asBool(true, false)).toBe(true);
    expect(asBool(false, true)).toBe(false);
  });
  it('数値は 0=false / 非0=true', () => {
    expect(asBool(0, true)).toBe(false);
    expect(asBool(1, false)).toBe(true);
    expect(asBool(-1, false)).toBe(true);
  });
  it('"true"/"1" → true, "false"/"0"/"" → false', () => {
    expect(asBool('true', false)).toBe(true);
    expect(asBool('1', false)).toBe(true);
    expect(asBool('false', true)).toBe(false);
    expect(asBool('0', true)).toBe(false);
    expect(asBool('', true)).toBe(false);
  });
  it('それ以外は fallback', () => {
    expect(asBool('maybe', true)).toBe(true);
    expect(asBool('maybe', false)).toBe(false);
    expect(asBool(null, true)).toBe(true);
    expect(asBool(undefined, false)).toBe(false);
  });
});

describe('asNonNegInt', () => {
  it('非負整数を受け入れる', () => {
    expect(asNonNegInt(0)).toBe(0);
    expect(asNonNegInt(1234)).toBe(1234);
  });
  it('小数は四捨五入', () => {
    expect(asNonNegInt(1.4)).toBe(1);
    expect(asNonNegInt(1.6)).toBe(2);
  });
  it('負値は null', () => {
    expect(asNonNegInt(-1)).toBeNull();
  });
  it('"1,000" / "1000" を解釈', () => {
    expect(asNonNegInt('1,000')).toBe(1000);
    expect(asNonNegInt('1000')).toBe(1000);
  });
  it('non-numeric / NaN / Infinity は null', () => {
    expect(asNonNegInt('abc')).toBeNull();
    expect(asNonNegInt(NaN)).toBeNull();
    expect(asNonNegInt(Infinity)).toBeNull();
    expect(asNonNegInt(null)).toBeNull();
  });
});

describe('asInt', () => {
  it('負値も受ける', () => {
    expect(asInt(-100)).toBe(-100);
    expect(asInt('-100')).toBe(-100);
  });
  it('NaN は null', () => {
    expect(asInt('xyz')).toBeNull();
  });
});

describe('asTimeStr', () => {
  it('HH:MM / HH:MM:SS を受ける', () => {
    expect(asTimeStr('09:00')).toBe('09:00');
    expect(asTimeStr('9:00')).toBe('9:00');
    expect(asTimeStr('23:59:59')).toBe('23:59:59');
  });
  it('不正な形式は null', () => {
    expect(asTimeStr('25-00')).toBeNull();
    expect(asTimeStr('9時')).toBeNull();
    expect(asTimeStr('')).toBeNull();
    expect(asTimeStr(900)).toBeNull();
  });
});

describe('asDateStr', () => {
  it('YYYY-MM-DD を受ける', () => {
    expect(asDateStr('2026-05-20')).toBe('2026-05-20');
  });
  it('YYYY/MM/DD やその他は null', () => {
    expect(asDateStr('2026/05/20')).toBeNull();
    expect(asDateStr('20260520')).toBeNull();
    expect(asDateStr('')).toBeNull();
  });
});

describe('asPeriodStr', () => {
  it('YYYY-MM を受ける', () => {
    expect(asPeriodStr('2026-05')).toBe('2026-05');
  });
  it('それ以外は null', () => {
    expect(asPeriodStr('2026-5')).toBeNull();
    expect(asPeriodStr('2026-13')).toBe('2026-13'); // 形式のみチェック、月の範囲は別途
    expect(asPeriodStr('')).toBeNull();
  });
});

describe('clampLimit', () => {
  it('正常値はそのまま', () => {
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit('100')).toBe(100);
  });
  it('上限 max でクランプ', () => {
    expect(clampLimit(500, 50, 200)).toBe(200);
  });
  it('0 / 負値は fallback', () => {
    expect(clampLimit(0, 50)).toBe(50);
    expect(clampLimit(-5, 50)).toBe(50);
  });
  it('NaN / undefined は fallback', () => {
    expect(clampLimit('abc', 50)).toBe(50);
    expect(clampLimit(undefined, 50)).toBe(50);
  });
});

describe('clampOffset', () => {
  it('正常値はそのまま', () => {
    expect(clampOffset(100)).toBe(100);
  });
  it('未指定は 0', () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset('')).toBe(0);
  });
  it('負値は 0', () => {
    expect(clampOffset(-50)).toBe(0);
  });
});
