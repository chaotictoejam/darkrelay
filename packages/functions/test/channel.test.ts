import { describe, expect, it } from 'vitest';
import {
  channelItems,
  channelTotals,
  listActiveVideos,
  listShorts,
  pullChannelCounts,
  type Report,
} from '../src/youtube/channel';

const RANGE = { from: '2026-10-05', to: '2026-10-11' };
const silent = () => {};

/** A report stub keyed on the dimensions asked for. */
function reporter(
  rows: Record<string, Record<string, string | number>[]>,
  fail: string[] = [],
): { report: Report; calls: Record<string, string>[] } {
  const calls: Record<string, string>[] = [];
  const report: Report = async (params) => {
    calls.push(params);
    const key = params['dimensions'] ?? '';
    if (fail.includes(key)) throw new Error(`YouTube refused ${key}`);
    return rows[key] ?? [];
  };
  return { report, calls };
}

describe('pullChannelCounts', () => {
  const rows = {
    day: [
      {
        day: '2026-10-10',
        views: 70,
        estimatedMinutesWatched: 120,
        subscribersGained: 9,
        subscribersLost: 2,
      },
      {
        day: '2026-10-11',
        views: 10,
        estimatedMinutesWatched: 5,
        subscribersGained: 1,
        subscribersLost: 0,
      },
    ],
    'day,insightTrafficSourceType': [
      { day: '2026-10-10', insightTrafficSourceType: 'SHORTS', views: 55 },
      { day: '2026-10-10', insightTrafficSourceType: 'YT_SEARCH', views: 15 },
      { day: '2026-10-11', insightTrafficSourceType: 'SUBSCRIBER', views: 10 },
    ],
    'day,creatorContentType': [
      { day: '2026-10-10', creatorContentType: 'SHORTS', views: 40, estimatedMinutesWatched: 20 },
      {
        day: '2026-10-10',
        creatorContentType: 'VIDEO_ON_DEMAND',
        views: 30,
        estimatedMinutesWatched: 100,
      },
    ],
  };

  it('gathers views, subscribers, traffic sources and the Shorts split per day', async () => {
    const { report } = reporter(rows);
    const days = await pullChannelCounts(report, RANGE, silent);
    expect([...days.keys()]).toEqual(['2026-10-10', '2026-10-11']);
    expect(days.get('2026-10-10')).toEqual({
      views: 70,
      watchSeconds: 7200,
      subscribersGained: 9,
      subscribersLost: 2,
      trafficSources: { SHORTS: 55, YT_SEARCH: 15 },
      formats: {
        short: { views: 40, watchSeconds: 1200 },
        long: { views: 30, watchSeconds: 6000 },
      },
    });
  });

  it('keeps the views when YouTube refuses a breakdown', async () => {
    const problems: string[] = [];
    const { report } = reporter(rows, ['day,creatorContentType']);
    const days = await pullChannelCounts(report, RANGE, (m, d) =>
      problems.push(`${m} ${JSON.stringify(d)}`),
    );
    expect(days.get('2026-10-10')).toMatchObject({ views: 70, formats: {} });
    expect(problems.join()).toMatch(/Shorts and long-form split/);
  });

  it('sums a range for an outlet page', () => {
    const days = new Map([
      [
        '2026-10-10',
        {
          views: 70,
          watchSeconds: 7200,
          subscribersGained: 9,
          subscribersLost: 2,
          trafficSources: { SHORTS: 55 },
          formats: { short: { views: 40, watchSeconds: 1200 } },
        },
      ],
      [
        '2026-10-11',
        {
          views: 10,
          watchSeconds: 300,
          subscribersGained: 1,
          subscribersLost: 3,
          trafficSources: { SHORTS: 10 },
          formats: { short: { views: 10, watchSeconds: 300 } },
        },
      ],
    ]);
    expect(channelTotals(days)).toEqual({
      views: 80,
      watchSeconds: 7500,
      subscribersGained: 10,
      subscribersLost: 5,
      trafficSources: { SHORTS: 65 },
      formats: { short: { views: 50, watchSeconds: 1500 } },
    });
  });

  it('keys items by brand and outlet, under the youtube source', () => {
    const items = channelItems(
      'cc',
      'youtube',
      new Map([
        [
          '2026-10-10',
          {
            views: 1,
            watchSeconds: 2,
            subscribersGained: 0,
            subscribersLost: 0,
            trafficSources: {},
            formats: {},
          },
        ],
      ]),
      '2026-10-12T04:00:00Z',
    );
    expect(items).toEqual([
      {
        pk: 'S#cc#O#youtube',
        sk: 'D#2026-10-10#youtube',
        show: 'cc',
        outlet: 'youtube',
        date: '2026-10-10',
        source: 'youtube',
        updatedAt: '2026-10-12T04:00:00Z',
        views: 1,
        watchSeconds: 2,
        subscribersGained: 0,
        subscribersLost: 0,
        trafficSources: {},
        formats: {},
      },
    ]);
  });
});

describe('listActiveVideos', () => {
  it('returns the videos with views, most watched first', async () => {
    const { report, calls } = reporter({
      video: [
        { video: 'v1', views: 30 },
        { video: 's1', views: 40 },
      ],
    });
    expect(await listActiveVideos(report, RANGE, silent)).toEqual([
      { videoId: 'v1', views: 30 },
      { videoId: 's1', views: 40 },
    ]);
    // One call for the whole channel, not one per video.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ dimensions: 'video', maxResults: '200', startIndex: '1' });
  });

  it('pages until a page comes back short', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ video: `v${i}`, views: 1 }));
    let call = 0;
    const report: Report = async () => (++call === 1 ? page(200) : page(3));
    expect(await listActiveVideos(report, RANGE, silent)).toHaveLength(203);
    expect(call).toBe(2);
  });

  it('gives nothing back when the report fails, instead of throwing', async () => {
    const { report } = reporter({}, ['video']);
    expect(await listActiveVideos(report, RANGE, silent)).toEqual([]);
  });
});

describe('listShorts', () => {
  it('asks YouTube which videos are Shorts rather than guessing from duration', async () => {
    const { report, calls } = reporter({ video: [{ video: 's1', views: 40 }] });
    expect([...(await listShorts(report, RANGE, silent))]).toEqual(['s1']);
    expect(calls[0]).toMatchObject({ filters: 'creatorContentType==SHORTS' });
  });
});
