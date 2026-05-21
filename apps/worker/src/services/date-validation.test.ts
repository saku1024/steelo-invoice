import { describe, it, expect } from 'vitest';
import {
  isCalendarValidDate,
  isCalendarValidTime,
  buildCalendarDate,
} from './date-validation.js';

describe('isCalendarValidDate', () => {
  it('実在する日付は true', () => {
    expect(isCalendarValidDate('2026-05-21')).toBe(true);
    expect(isCalendarValidDate('2024-02-29')).toBe(true); // 閏年
    expect(isCalendarValidDate('2026-12-31')).toBe(true);
  });
  it('実在しない日付は false', () => {
    expect(isCalendarValidDate('2026-02-30')).toBe(false);
    expect(isCalendarValidDate('2026-02-31')).toBe(false);
    expect(isCalendarValidDate('2025-02-29')).toBe(false); // 非閏年
    expect(isCalendarValidDate('2026-13-01')).toBe(false);
    expect(isCalendarValidDate('2026-04-31')).toBe(false);
  });
  it('形式不正は false', () => {
    expect(isCalendarValidDate('2026/05/21')).toBe(false);
    expect(isCalendarValidDate('20260521')).toBe(false);
    expect(isCalendarValidDate('')).toBe(false);
    expect(isCalendarValidDate(null)).toBe(false);
    expect(isCalendarValidDate(undefined)).toBe(false);
  });
});

describe('isCalendarValidTime', () => {
  it('実在する時刻は true', () => {
    expect(isCalendarValidTime('09:00')).toBe(true);
    expect(isCalendarValidTime('9:00')).toBe(true);
    expect(isCalendarValidTime('23:59:59')).toBe(true);
    expect(isCalendarValidTime('00:00')).toBe(true);
  });
  it('範囲外は false', () => {
    expect(isCalendarValidTime('24:00')).toBe(false);
    expect(isCalendarValidTime('25:99')).toBe(false);
    expect(isCalendarValidTime('12:60')).toBe(false);
    expect(isCalendarValidTime('99:99')).toBe(false);
  });
  it('形式不正は false', () => {
    expect(isCalendarValidTime('9時')).toBe(false);
    expect(isCalendarValidTime('')).toBe(false);
    expect(isCalendarValidTime(null)).toBe(false);
  });
});

describe('buildCalendarDate', () => {
  it('正常な period + workDay は YYYY-MM-DD を返す', () => {
    expect(buildCalendarDate('2026-05', 21)).toBe('2026-05-21');
    expect(buildCalendarDate('2024-02', 29)).toBe('2024-02-29');
  });
  it('実在しない組合せは null', () => {
    expect(buildCalendarDate('2026-02', 31)).toBeNull();
    expect(buildCalendarDate('2025-02', 29)).toBeNull();
    expect(buildCalendarDate('2026-04', 31)).toBeNull();
  });
  it('範囲外は null', () => {
    expect(buildCalendarDate('2026-05', 0)).toBeNull();
    expect(buildCalendarDate('2026-05', 32)).toBeNull();
    expect(buildCalendarDate('2026-13', 1)).toBeNull(); // 月の範囲は buildCalendarDate では一旦受けて Date でチェック
  });
  it('形式不正な period は null', () => {
    expect(buildCalendarDate('2026/05', 21)).toBeNull();
    expect(buildCalendarDate('2026-5', 21)).toBeNull();
  });
});
