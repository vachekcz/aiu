import { describe, expect, it } from 'vitest';
import { asArray, asDate, asNumber, asRecord, asString, windowKind, windowLabel } from '../../src/providers/parsing.ts';

describe('windowLabel', () => {
  it('names common window lengths', () => {
    expect(windowLabel(18_000)).toBe('5h');
    expect(windowLabel(604_800)).toBe('Week');
    expect(windowLabel(86_400)).toBe('1d');
    expect(windowLabel(7_200)).toBe('2h');
  });

  it('falls back to days, then minutes', () => {
    expect(windowLabel(1_209_600)).toBe('14d');
    expect(windowLabel(1_800)).toBe('30m');
    expect(windowLabel(100)).toBe('2m');
  });
});

describe('windowKind', () => {
  it('splits at one week', () => {
    expect(windowKind(18_000)).toBe('session');
    expect(windowKind(604_799)).toBe('session');
    expect(windowKind(604_800)).toBe('weekly');
    expect(windowKind(2_592_000)).toBe('weekly');
  });
});

describe('tolerant readers', () => {
  it('asRecord accepts plain objects only', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('text')).toBeNull();
  });

  it('asArray turns anything else into an empty list', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ length: 1 })).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });

  it('asNumber rejects non-finite and non-number values', () => {
    expect(asNumber(0)).toBe(0);
    expect(asNumber(Number.NaN)).toBeNull();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asNumber('5')).toBeNull();
  });

  it('asString accepts strings only', () => {
    expect(asString('')).toBe('');
    expect(asString(5)).toBeNull();
  });

  it('asDate reads ISO strings and epoch milliseconds, and rejects the rest', () => {
    expect(asDate('2026-11-18T22:00:00Z')).toEqual(new Date('2026-11-18T22:00:00Z'));
    expect(asDate(1_000)).toEqual(new Date(1_000));
    expect(asDate('not a date')).toBeNull();
    expect(asDate(null)).toBeNull();
    expect(asDate({})).toBeNull();
  });
});
