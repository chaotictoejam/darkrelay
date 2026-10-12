import { describe, expect, it } from 'vitest';
import { dateRange, route, summarize, type Query } from '../src/analytics/api';

const NOW = new Date('2026-10-12T12:00:00Z');
const item = (date: string, source: string, downloads: number, apps = {}) => ({
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
});

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
    SHOWS: [{ pk: 'SHOWS', sk: 'S#cc', show: 'cc', title: 'Chaotic Commits' }],
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
    ],
    'S#cc#ALL': [
      item('2026-07-01', 'cloudfront', 100),
      item('2026-10-10', 'cloudfront', 4, { Overcast: 4 }),
      item('2026-10-10', 'youtube', 2, { YouTube: 2 }),
      item('2026-10-11', 'cloudfront', 6, { Overcast: 6 }),
    ],
    'S#cc#E#0000000000000002': [item('2026-10-11', 'cloudfront', 6)],
  });

  it('lists shows with the last processed day', async () => {
    expect((await route(q, '/shows', {}, NOW)).body).toEqual({
      shows: [{ show: 'cc', title: 'Chaotic Commits' }],
      lastRun: { pk: 'RUN#cloudfront', sk: '2026-10-11', date: '2026-10-11' },
    });
  });

  it('returns a show overview for the last 90 days, newest episodes first, sources combined', async () => {
    const res = await route(q, '/shows/cc', {}, NOW);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['from']).toBe('2026-07-15');
    expect((body['episodes'] as { title: string }[]).map((e) => e.title)).toEqual(['New', 'Old']);
    expect(body['daily']).toEqual([
      { date: '2026-10-10', downloads: 6, serverDownloads: 2 },
      { date: '2026-10-11', downloads: 6, serverDownloads: 1 },
    ]);
    expect(body['totals']).toMatchObject({ downloads: 12, apps: { Overcast: 10, YouTube: 2 } });
    expect(body['sources']).toEqual(['cloudfront', 'youtube']);
    expect(body['episodes']).not.toContainEqual(expect.objectContaining({ pk: expect.anything() }));
  });

  it('returns an episode', async () => {
    const res = await route(
      q,
      '/shows/cc/episodes/0000000000000002',
      { from: '2026-10-01', to: '2026-10-31' },
      NOW,
    );
    expect(res.body).toMatchObject({ episode: { title: 'New' }, totals: { downloads: 6 } });
  });

  it('rejects bad input and unknown paths without querying', async () => {
    const before = calls.length;
    expect((await route(q, '/shows/BAD!', {}, NOW)).statusCode).toBe(400);
    expect((await route(q, '/shows/cc/episodes/xyz', {}, NOW)).statusCode).toBe(400);
    expect((await route(q, '/other', {}, NOW)).statusCode).toBe(404);
    expect(calls.length).toBe(before);
  });

  it('404s an episode with no data yet', async () => {
    expect((await route(q, '/shows/cc/episodes/00000000000000ff', {}, NOW)).statusCode).toBe(404);
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
    expect(summarize([])).toMatchObject({ daily: [], sources: [], totals: { downloads: 0 } });
  });
});
