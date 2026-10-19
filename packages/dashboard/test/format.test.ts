import { describe, expect, it } from 'vitest';
import {
  compact,
  daysBetween,
  deviceName,
  duration,
  fillDays,
  niceTicks,
  podcastApps,
  sourceName,
  topEntries,
} from '../src/format';

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

  it.each([
    [42, '42s'],
    [144, '2m 24s'],
    [5400, '1h 30m'],
    [7200, '2h'],
    [45000, '12h'],
  ])('duration(%s) = %s', (n, out) => expect(duration(n)).toBe(out));

  it('names sources, and passes unknown ones through', () => {
    expect(sourceName('youtube')).toBe('YouTube (views)');
    expect(sourceName('new-source')).toBe('new-source');
  });

  it('counts podcast apps from download sources only', () => {
    expect(
      podcastApps([
        { source: 'cloudfront', apps: { Overcast: 3, 'Apple Podcasts': 2 } },
        { source: 'prefix', apps: { Overcast: 1 } },
        { source: 'youtube', apps: { YouTube: 9 } },
        { source: 'spotify-csv' },
      ]),
    ).toEqual({ Overcast: 4, 'Apple Podcasts': 2 });
  });
});
