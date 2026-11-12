import { describe, expect, it } from 'vitest';
import { accessFromGroups } from '@darkrelay/core';
import {
  dateRange,
  outletOf,
  route,
  summarize,
  summarizeChannel,
  type Query,
} from '../src/analytics/api';

const NOW = new Date('2026-10-12T12:00:00Z');
const ADMIN = accessFromGroups(['admin']);
const item = (date: string, source: string, downloads: number, apps = {}, extra = {}) => ({
  pk: 'x',
  sk: `D#${date}#${source}`,
  show: 'cc',
  date,
  source,
  downloads,
  serverDownloads: 1,
  apps,
  countries: {},
  devices: {},
  updatedAt: '',
  ...extra,
});

const OUTLETS = [
  { id: 'rss', kind: 'rss', name: 'RSS feed (cc)', source: 'cloudfront', show: 'cc' },
  { id: 'youtube', kind: 'youtube', name: 'Chaotic Commits', source: 'youtube' },
];

function fakeQuery(data: Record<string, Record<string, unknown>[]>) {
  const calls: unknown[] = [];
  const q: Query = async (pk, sk) => {
    calls.push([pk, sk]);
    let rows = data[pk] ?? [];
    if (sk?.beginsWith) rows = rows.filter((r) => String(r['sk']).startsWith(sk.beginsWith!));
    if (sk?.between)
      rows = rows.filter(
        (r) => String(r['sk']) >= sk.between![0] && String(r['sk']) <= sk.between![1],
      );
    return sk?.latest ? rows.slice(-1) : rows;
  };
  return { q, calls };
}

describe('route', () => {
  const { q, calls } = fakeQuery({
    SHOWS: [
      {
        pk: 'SHOWS',
        sk: 'S#cc',
        show: 'cc',
        title: 'Chaotic Commits',
        iconKey: 'cc/icon.jpg',
        outlets: OUTLETS,
      },
    ],
    'RUN#cloudfront': [{ pk: 'RUN#cloudfront', sk: '2026-10-11', date: '2026-10-11' }],
    'S#cc': [
      {
        pk: 'S#cc',
        sk: 'E#0000000000000001',
        title: 'Old',
        pubDate: '2026-01-01T00:00:00Z',
        downloads7: 3,
      },
      {
        pk: 'S#cc',
        sk: 'E#0000000000000002',
        title: 'New',
        pubDate: '2026-10-01T00:00:00Z',
        downloads7: 5,
      },
      {
        pk: 'S#cc',
        sk: 'V#short1',
        videoId: 'short1',
        outlet: 'youtube',
        title: 'A Short',
        publishedAt: '2026-10-08T00:00:00Z',
        format: 'short',
        downloadsTotal: 40,
      },
      {
        pk: 'S#cc',
        sk: 'V#talk12',
        videoId: 'talk12',
        outlet: 'youtube',
        title: 'A talk',
        publishedAt: '2026-09-01T00:00:00Z',
        format: 'long',
        downloadsTotal: 10,
      },
    ],
    'S#cc#ALL': [
      item('2026-07-01', 'cloudfront', 100),
      item('2026-10-10', 'cloudfront', 4, { Overcast: 4 }),
      item('2026-10-10', 'youtube', 2, { YouTube: 2 }, { outlet: 'youtube' }),
      item('2026-10-11', 'cloudfront', 6, { Overcast: 6 }),
    ],
    'S#cc#E#0000000000000002': [item('2026-10-11', 'cloudfront', 6)],
    'S#cc#V#short1': [item('2026-10-10', 'youtube', 40, { YouTube: 40 }, { outlet: 'youtube' })],
    'S#cc#O#youtube': [
      {
        pk: 'S#cc#O#youtube',
        sk: 'D#2026-10-10#youtube',
        show: 'cc',
        outlet: 'youtube',
        date: '2026-10-10',
        source: 'youtube',
        views: 70,
        watchSeconds: 7200,
        subscribersGained: 9,
        subscribersLost: 2,
        trafficSources: { SHORTS: 55, YT_SEARCH: 15 },
        formats: { short: { views: 40, watchSeconds: 1200 } },
      },
    ],
  });

  it('lists brands with their icon and outlets, under both names', async () => {
    const body = (await route(q, '/shows', {}, ADMIN, NOW)).body as Record<string, unknown>;
    expect(body['shows']).toEqual([
      {
        show: 'cc',
        brand: 'cc',
        title: 'Chaotic Commits',
        iconKey: 'cc/icon.jpg',
        iconUrl: undefined,
        outlets: [
          { id: 'rss', kind: 'rss', name: 'RSS feed (cc)', source: 'cloudfront' },
          { id: 'youtube', kind: 'youtube', name: 'Chaotic Commits', source: 'youtube' },
        ],
      },
    ]);
    expect(body['brands']).toEqual(body['shows']);
    expect(body['lastRun']).toMatchObject({ date: '2026-10-11' });
    expect((await route(q, '/brands', {}, ADMIN, NOW)).body).toEqual(body);
  });

  it('returns a brand overview with episodes, videos and a by-outlet split', async () => {
    const res = await route(q, '/shows/cc', {}, ADMIN, NOW);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['from']).toBe('2026-07-15');
    expect(body['title']).toBe('Chaotic Commits');
    expect((body['episodes'] as { title: string }[]).map((e) => e.title)).toEqual(['New', 'Old']);
    expect((body['videos'] as { title: string }[]).map((v) => v.title)).toEqual([
      'A Short',
      'A talk',
    ]);
    expect(body['daily']).toEqual([
      { date: '2026-10-10', downloads: 6, serverDownloads: 2 },
      { date: '2026-10-11', downloads: 6, serverDownloads: 1 },
    ]);
    expect(body['totals']).toMatchObject({ downloads: 12, apps: { Overcast: 10, YouTube: 2 } });
    expect(body['byOutlet']).toEqual([
      {
        id: 'rss',
        kind: 'rss',
        name: 'RSS feed (cc)',
        source: 'cloudfront',
        plays: 10,
        watchSeconds: 0,
        apps: { Overcast: 10 },
      },
      {
        id: 'youtube',
        kind: 'youtube',
        name: 'Chaotic Commits',
        source: 'youtube',
        plays: 2,
        watchSeconds: 0,
        apps: { YouTube: 2 },
      },
    ]);
    // The old table is still there, so an older dashboard build keeps working.
    expect(body['bySource']).toHaveLength(2);
    expect(body['episodes']).not.toContainEqual(expect.objectContaining({ pk: expect.anything() }));
  });

  it('returns an episode', async () => {
    const res = await route(
      q,
      '/shows/cc/episodes/0000000000000002',
      { from: '2026-10-01', to: '2026-10-31' },
      ADMIN,
      NOW,
    );
    expect(res.body).toMatchObject({ episode: { title: 'New' }, totals: { downloads: 6 } });
  });

  it('returns a video that is not an episode', async () => {
    const res = await route(q, '/brands/cc/videos/short1', {}, ADMIN, NOW);
    expect(res.body).toMatchObject({
      video: { title: 'A Short', format: 'short' },
      totals: { downloads: 40 },
    });
  });

  it('returns a YouTube outlet page: channel numbers, its content, and its videos', async () => {
    const res = await route(q, '/brands/cc/outlets/youtube', {}, ADMIN, NOW);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['outlet']).toMatchObject({ id: 'youtube', kind: 'youtube' });
    expect(body['channel']).toMatchObject({
      totals: {
        views: 70,
        subscribersGained: 9,
        subscribersLost: 2,
        trafficSources: { SHORTS: 55, YT_SEARCH: 15 },
        formats: { short: { views: 40, watchSeconds: 1200 } },
      },
      subscriberChange: 7,
    });
    // Only this outlet's content, not the feed's downloads.
    expect(body['content']).toMatchObject({ totals: { downloads: 2 } });
    expect((body['videos'] as { title: string }[]).map((v) => v.title)).toEqual([
      'A Short',
      'A talk',
    ]);
  });

  it('404s an outlet the brand does not have', async () => {
    expect((await route(q, '/brands/cc/outlets/spotify', {}, ADMIN, NOW)).statusCode).toBe(404);
  });

  it('rejects bad input and unknown paths without querying', async () => {
    const before = calls.length;
    expect((await route(q, '/shows/BAD!', {}, ADMIN, NOW)).statusCode).toBe(400);
    expect((await route(q, '/shows/cc/episodes/xyz', {}, ADMIN, NOW)).statusCode).toBe(400);
    expect((await route(q, '/shows/cc/videos/no', {}, ADMIN, NOW)).statusCode).toBe(400);
    expect((await route(q, '/shows/cc/outlets/NOPE', {}, ADMIN, NOW)).statusCode).toBe(400);
    expect((await route(q, '/other', {}, ADMIN, NOW)).statusCode).toBe(404);
    expect(calls.length).toBe(before);
  });

  it('lists only the brands the caller may see', async () => {
    const shows = (r: Awaited<ReturnType<typeof route>>) =>
      (r.body as { shows: { show: string }[] }).shows.map((s) => s.show);
    expect(shows(await route(q, '/shows', {}, accessFromGroups([]), NOW))).toEqual([]);
    expect(shows(await route(q, '/shows', {}, accessFromGroups(['viewer:other']), NOW))).toEqual(
      [],
    );
    expect(shows(await route(q, '/shows', {}, accessFromGroups(['uploader:cc']), NOW))).toEqual([
      'cc',
    ]);
  });

  it('403s a brand, episode, video or outlet the caller has no role for, without querying', async () => {
    const before = calls.length;
    for (const groups of [[], ['viewer:other'], ['uploader:other'], ['viewer']]) {
      const access = accessFromGroups(groups);
      for (const path of [
        '/shows/cc',
        '/shows/cc/episodes/0000000000000002',
        '/shows/cc/videos/short1',
        '/shows/cc/outlets/youtube',
      ]) {
        expect((await route(q, path, {}, access, NOW)).statusCode).toBe(403);
      }
    }
    expect(calls.length).toBe(before);
    expect((await route(q, '/shows/cc', {}, accessFromGroups(['viewer:cc']), NOW)).statusCode).toBe(
      200,
    );
  });

  it('404s an episode or video with no data yet', async () => {
    expect((await route(q, '/shows/cc/episodes/00000000000000ff', {}, ADMIN, NOW)).statusCode).toBe(
      404,
    );
    expect((await route(q, '/shows/cc/videos/unknown1234', {}, ADMIN, NOW)).statusCode).toBe(404);
  });
});

describe('outletOf', () => {
  it('prefers the outlet an item names', () => {
    expect(
      outletOf({ source: 'youtube', outlet: 'clips' }, [
        { id: 'main', kind: 'youtube', name: 'Main', source: 'youtube' },
        { id: 'clips', kind: 'youtube', name: 'Clips', source: 'youtube' },
      ]),
    ).toMatchObject({ id: 'clips' });
  });

  it('matches older items, which name no outlet, by their source', () => {
    expect(outletOf({ source: 'cloudfront' }, OUTLETS)).toMatchObject({ id: 'rss' });
  });

  it('keeps a source with no outlet rather than dropping its numbers', () => {
    expect(outletOf({ source: 'apple-csv' }, OUTLETS)).toEqual({
      id: 'apple-csv',
      kind: 'unknown',
      name: 'apple-csv',
      source: 'apple-csv',
    });
  });
});

describe('dateRange', () => {
  it('ignores malformed dates and swaps reversed ranges', () => {
    expect(dateRange({ from: 'nope', to: '2026-10-12' }, NOW)).toEqual({
      from: '2026-07-15',
      to: '2026-10-12',
    });
    expect(dateRange({ from: '2026-10-12', to: '2026-10-01' }, NOW)).toEqual({
      from: '2026-10-01',
      to: '2026-10-12',
    });
  });
});

describe('summarize', () => {
  it('handles no data', () => {
    expect(summarize([])).toMatchObject({
      daily: [],
      sources: [],
      byOutlet: [],
      totals: { downloads: 0 },
    });
  });
});

describe('summarizeChannel', () => {
  it('handles no data, and an item missing a breakdown', () => {
    expect(summarizeChannel([])).toMatchObject({ daily: [], subscriberChange: 0 });
    const sparse = summarizeChannel([{ date: '2026-10-10', views: 5 }] as unknown as Parameters<
      typeof summarizeChannel
    >[0]);
    expect(sparse.totals).toMatchObject({ views: 5, trafficSources: {}, formats: {} });
  });
});
