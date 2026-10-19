import { EpisodeManifest, metricKeys, type MetricItem } from '@darkrelay/core';
import { describe, expect, it } from 'vitest';
import {
  aggregateDay,
  decodeUserAgent,
  defaultDates,
  windowTotals,
  type AggregateDeps,
} from '../src/analytics/aggregate';
import { dailyQuery } from '../src/analytics/query';

const ID = '676385c932b682b4';
const PATH = `/chaotic-commits/${ID}/imported/audio.mp3`;
const APPLE = 'Podcasts/1650.20%20CFNetwork/1408.0.4%20Darwin/22.5.0';

const manifest = EpisodeManifest.parse({
  schemaVersion: 1,
  guid: 'g-1',
  title: 'Ep 1',
  description: '',
  pubDate: '2026-10-09T10:00:00Z',
  durationSeconds: 3600,
  enclosure: {
    asset: { key: `chaotic-commits/${ID}/imported/audio.mp3` },
    length: 60_000_000,
    type: 'audio/mpeg',
  },
  updatedAt: '2026-10-09T10:00:00Z',
});

function fakeDeps(rows: Record<string, string>[]) {
  const table = new Map<string, Record<string, unknown>>();
  const deps: AggregateDeps = {
    queryDay: async () => ({ rows, bytesScanned: 1234 }),
    loadManifest: async (show, id) =>
      show === 'chaotic-commits' && id === ID ? manifest : undefined,
    loadShowTitle: async () => 'Chaotic Commits',
    put: async (items) => {
      for (const i of items) table.set(`${i['pk']}|${i['sk']}`, i);
    },
    episodeSeries: async (show, id) =>
      [...table.values()].filter(
        (i) => i['pk'] === metricKeys.episodeSeries(show, id),
      ) as unknown as MetricItem[],
    now: () => new Date('2026-10-12T03:30:00Z'),
    log: () => {},
  };
  return { deps, table };
}

const row = (o: Record<string, string> = {}) => ({
  path: PATH,
  user_agent: APPLE,
  country: 'US',
  requests: '3',
  bytes: '60000000',
  ...o,
});

describe('aggregateDay', () => {
  it('writes episode, show, summary, show list and run items', async () => {
    const { deps, table } = fakeDeps([
      row(),
      row({ country: 'CA' }),
      row({ user_agent: 'Googlebot/2.1' }),
      row({ bytes: '2' }),
      row({ user_agent: 'audiobookshelf%20(+https://audiobookshelf.org)' }),
    ]);
    const run = await aggregateDay(deps, '2026-10-11');
    expect(run).toMatchObject({
      groups: 5,
      episodes: 1,
      bytesScanned: 1234,
      filtered: { bots: 1, belowMinimum: 1, notAudio: 0 },
    });

    expect(table.get(`S#chaotic-commits#E#${ID}|D#2026-10-11#cloudfront`)).toMatchObject({
      downloads: 2,
      serverDownloads: 1,
      apps: { 'Apple Podcasts': 2 },
      countries: { US: 1, CA: 1 },
    });
    expect(table.get('S#chaotic-commits#ALL|D#2026-10-11#cloudfront')).toMatchObject({
      downloads: 2,
    });
    expect(table.get('SHOWS|S#chaotic-commits')).toMatchObject({ title: 'Chaotic Commits' });
    expect(table.get(`S#chaotic-commits|E#${ID}`)).toMatchObject({
      title: 'Ep 1',
      downloads7: 2,
      downloadsTotal: 2,
      serverTotal: 1,
    });
    expect(table.get('RUN#cloudfront|2026-10-11')).toBeDefined();
  });

  it('keeps potential crawler downloads in the total and tallies them', async () => {
    const chrome = 'Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X%2010_15_7)%20Chrome/130.0';
    const episodes = [
      '676385c932b682b4',
      '0000000000000001',
      '0000000000000002',
      '0000000000000003',
      '0000000000000004',
    ];
    const { deps, table } = fakeDeps([
      ...episodes.map((id, i) =>
        row({
          path: `/chaotic-commits/${id}/imported/audio.mp3`,
          user_agent: chrome,
          asn: '2907',
          client: String(i),
        }),
      ),
      row({ asn: '2907', client: '9' }),
    ]);
    await aggregateDay(deps, '2026-10-11');
    expect(table.get('S#chaotic-commits#ALL|D#2026-10-11#cloudfront')).toMatchObject({
      downloads: 6,
      suspectDownloads: 5,
    });
    expect(table.get(`S#chaotic-commits|E#${ID}`)).toMatchObject({
      downloadsTotal: 2,
      suspectTotal: 1,
    });
  });

  it('is idempotent: re-running a day overwrites instead of adding', async () => {
    const { deps, table } = fakeDeps([row()]);
    await aggregateDay(deps, '2026-10-11');
    await aggregateDay(deps, '2026-10-11');
    expect(table.get(`S#chaotic-commits|E#${ID}`)).toMatchObject({ downloadsTotal: 1 });
  });

  it('writes only a run record for a day with no downloads', async () => {
    const { deps, table } = fakeDeps([]);
    await aggregateDay(deps, '2026-10-11');
    expect([...table.keys()]).toEqual(['RUN#cloudfront|2026-10-11']);
  });
});

describe('windowTotals', () => {
  const item = (date: string, downloads: number) =>
    ({ date, downloads, serverDownloads: 0 }) as MetricItem;
  it('counts days since release, release day being day 0', () => {
    expect(
      windowTotals('2026-10-01T22:00:00Z', [
        item('2026-10-01', 5),
        item('2026-10-07', 1),
        item('2026-10-08', 2),
        item('2026-10-30', 3),
        item('2026-12-29', 4),
        item('2026-12-30', 6),
      ]),
    ).toEqual({
      downloads7: 6,
      downloads30: 11,
      downloads90: 15,
      downloadsTotal: 21,
      serverTotal: 0,
      suspectTotal: 0,
      watchSecondsTotal: 0,
    });
  });
});

describe('dailyQuery', () => {
  const target = {
    database: 'darkrelay_analytics',
    table: 'cloudfront_logs',
    distributionId: 'E2ABC123',
  };
  it('scans the day plus the early hours of the next, filtered to the day', () => {
    const sql = dailyQuery(target, '2026-10-31');
    expect(sql).toContain('(year = 2026 AND month = 10 AND day = 31)');
    expect(sql).toContain('(year = 2026 AND month = 11 AND day = 1) AND hour < 3');
    expect(sql).toContain(`"date" = '2026-10-31'`);
    expect(sql).toContain('GROUP BY cs_uri_stem, c_ip, cs_user_agent');
    // The IP only feeds a per-day index, through a hash; it is never returned.
    expect(sql).toContain(
      'dense_rank() OVER (ORDER BY xxhash64(to_utf8(c_ip))) AS varchar) AS client',
    );
    expect(sql.replace('xxhash64(to_utf8(c_ip))', '')).not.toMatch(/SELECT[^]*c_ip[^]*FROM/);
  });
  it('rejects anything that is not a date or distribution id', () => {
    expect(() => dailyQuery(target, "2026-10-31' OR 1=1")).toThrow();
    expect(() => dailyQuery({ ...target, distributionId: "E1' --" }, '2026-10-31')).toThrow();
  });
});

describe('helpers', () => {
  it('decodes URL-encoded user agents and survives bad encoding', () => {
    expect(decodeUserAgent(APPLE)).toBe('Podcasts/1650.20 CFNetwork/1408.0.4 Darwin/22.5.0');
    expect(decodeUserAgent('bad%zz')).toBe('bad%zz');
  });
  it('defaults to yesterday and the day before', () => {
    expect(defaultDates(new Date('2026-10-12T03:30:00Z'))).toEqual(['2026-10-10', '2026-10-11']);
  });
});
