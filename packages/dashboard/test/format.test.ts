import { describe, expect, it } from 'vitest';
import { compact, daysBetween, deviceName, fillDays, niceTicks, topEntries } from '../src/format';

describe('format', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1284, '1.3K'],
    [12_900, '12.9K'],
    [125_000, '125K'],
    [4_200_000, '4.2M'],
  ])('compact(%s) = %s', (n, s) => expect(compact(n)).toBe(s));

  it('fills missing days with zeros, inclusive', () => {
    const rows = fillDays([{ date: '2026-10-02', v: 5 }], '2026-10-01', '2026-10-03', (date) => ({
      date,
      v: 0,
    }));
    expect(rows.map((r) => r.v)).toEqual([0, 5, 0]);
    expect(daysBetween('2026-10-30', '2026-11-01')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('picks clean ticks that cover the max', () => {
    expect(niceTicks(47)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(1840)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('folds the tail into Other', () => {
    expect(topEntries({ a: 5, b: 4, c: 3, d: 2, e: 1 }, 3)).toEqual([
      ['a', 5],
      ['b', 4],
      ['Other', 6],
    ]);
  });

  it('names device categories', () => {
    expect(deviceName('smart_speaker')).toBe('Smart speaker');
    expect(deviceName('new_thing')).toBe('new thing');
  });
});
