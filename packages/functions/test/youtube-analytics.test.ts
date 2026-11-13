import {
  BrandConfig,
  EpisodeManifest,
  YouTube,
  episodeId,
  metricKeys,
  type MetricItem,
} from '@darkrelay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultRange, pullYouTube, type YouTubeAnalyticsDeps } from '../src/youtube/analytics';
import { FakeYouTube } from './fake-youtube';

let fake: FakeYouTube;
beforeAll(async () => {
  fake = await new FakeYouTube().start();
});
afterAll(() => fake.stop());

const RANGE = { from: '2026-10-05', to: '2026-10-11' };
const NOW = new Date('2026-10-12T04:00:00Z');

/** Chaotic Commits: a feed plus a channel. */
const podcastBrand = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'cc',
  name: 'Chaotic Commits',
  icon: { key: 'cc/icon.jpg' },
  outlets: [
    { kind: 'rss', id: 'rss', show: 'cc' },
    { kind: 'youtube', id: 'youtube', connection: 'cc' },
  ],
});

/** Dr. Joanne Skiles: a channel and nothing else. */
const channelBrand = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'drjoanneskiles',
  name: 'Dr. Joanne Skiles',
  outlets: [{ kind: 'youtube', id: 'youtube', connection: 'drjoanneskiles' }],
});

const ep = (guid: string, videoId?: string) =>
  EpisodeManifest.parse({
    schemaVersion: 1,
    guid,
    title: guid,
    description: '',
    pubDate: '2026-10-09T10:00:00Z',
    enclosure: { asset: { key: 'a' }, length: 1, type: 'audio/mpeg' },
    youtube: videoId ? { videoId, linkedAt: '2026-10-09T10:00:00Z' } : undefined,
    updatedAt: '2026-10-09T10:00:00Z',
  });

let table: Map<string, Record<string, unknown>>;

function deps(over: Partial<YouTubeAnalyticsDeps> = {}): YouTubeAnalyticsDeps {
  return {
    brands: async () => [podcastBrand],
    episodes: async () => [ep('e1', 'v1'), ep('not-on-youtube')],
    youtubeFor: async () => new YouTube('token', fake.endpoints),
    put: async (items) => {
      for (const i of items) table.set(`${i['pk']}|${i['sk']}`, i);
    },
    series: async (pk) =>
      [...table.values()].filter((i) => i['pk'] === pk) as unknown as MetricItem[],
    now: () => NOW,
    log: () => {},
    ...over,
  };
}

/** views/watch per day for a video, plus the channel reports the puller asks for. */
function standardReports() {
  fake.reports = (p) => {
    const dimensions = p.get('dimensions');
    const col = (...names: string[]) => names.map((name) => ({ name }));
    if (dimensions === 'video' && p.get('filters') === 'creatorContentType==SHORTS') {
      return { columnHeaders: col('video', 'views'), rows: [['s1', 40]] };
    }
    if (dimensions === 'video') {
      return {
        columnHeaders: col('video', 'views'),
        rows: [
          ['v1', 30],
          ['s1', 40],
        ],
      };
    }
    if (dimensions === 'day,insightTrafficSourceType') {
      return {
        columnHeaders: col('day', 'insightTrafficSourceType', 'views'),
        rows: [
          ['2026-10-10', 'SHORTS', 55],
          ['2026-10-10', 'YT_SEARCH', 15],
        ],
      };
    }
    if (dimensions === 'day,creatorContentType') {
      return {
        columnHeaders: col('day', 'creatorContentType', 'views', 'estimatedMinutesWatched'),
        rows: [
          ['2026-10-10', 'SHORTS', 40, 20],
          ['2026-10-10', 'VIDEO_ON_DEMAND', 30, 100],
        ],
      };
    }
    // One video's own days. The real API tells this apart from the
    // channel-wide report by the video filter, so the fake does too.
    if (dimensions === 'day' && (p.get('filters') ?? '').startsWith('video==')) {
      const video = p.get('filters')!.split('==')[1];
      const views = video === 'v1' ? 10 : 20;
      const subs = p.get('metrics')!.includes('subscribersGained');
      return {
        columnHeaders: subs
          ? col('day', 'views', 'estimatedMinutesWatched', 'subscribersGained')
          : col('day', 'views', 'estimatedMinutesWatched'),
        rows: [
          ['2026-10-09', views, 30.5, ...(subs ? [1] : [])],
          ['2026-10-10', views * 2, 61, ...(subs ? [3] : [])],
        ],
      };
    }
    if (dimensions === 'day' && p.get('metrics')!.includes('subscribersGained')) {
      return {
        columnHeaders: col(
          'day',
          'views',
          'estimatedMinutesWatched',
          'subscribersGained',
          'subscribersLost',
        ),
        rows: [['2026-10-10', 70, 120, 9, 2]],
      };
    }
    if (dimensions === 'elapsedVideoTimeRatio') {
      return {
        columnHeaders: col('elapsedVideoTimeRatio', 'audienceWatchRatio'),
        rows: [
          [0.01, 1],
          [0.5, 0.42],
        ],
      };
    }
    const video = p.get('filters')!.split('==')[1];
    const views = video === 'v1' ? 10 : 20;
    return {
      columnHeaders: col('day', 'views', 'estimatedMinutesWatched'),
      rows: [
        ['2026-10-09', views, 30.5],
        ['2026-10-10', views * 2, 61],
      ],
    };
  };
}

beforeEach(() => {
  table = new Map();
  fake.uploads = [];
  fake.details = new Map([
    ['s1', { duration: 'PT45S', title: 'A Short', publishedAt: '2026-10-08T12:00:00Z' }],
  ]);
  standardReports();
});

describe('pullYouTube', () => {
  it("writes an episode's views to its episode series, as before", async () => {
    await pullYouTube(deps(), RANGE);
    const id = episodeId('e1');
    expect(table.get(`${metricKeys.episodeSeries('cc', id)}|D#2026-10-10#youtube`)).toMatchObject({
      source: 'youtube',
      downloads: 20,
      watchSeconds: 3660,
      apps: { YouTube: 20 },
      outlet: 'youtube',
    });
    const summary = table.get(`S#cc|${metricKeys.episodeMeta(id)}`);
    expect(summary).toMatchObject({ youtubeVideoId: 'v1', downloadsTotal: 30 });
  });

  it('writes a video that is not an episode under its own key, with its format', async () => {
    await pullYouTube(deps(), RANGE);
    expect(table.get(`${metricKeys.videoSeries('cc', 's1')}|D#2026-10-10#youtube`)).toMatchObject({
      videoId: 's1',
      downloads: 40,
      outlet: 'youtube',
    });
    expect(table.get(`S#cc|${metricKeys.videoMeta('s1')}`)).toMatchObject({
      videoId: 's1',
      title: 'A Short',
      format: 'short',
      durationSeconds: 45,
      publishedAt: '2026-10-08T12:00:00Z',
      downloadsTotal: 60,
    });
  });

  it("records a video's own subscribers, which is what slot scoring needs", async () => {
    await pullYouTube(deps(), RANGE);
    // Subscribers are attributed per video, so a publish time can be judged
    // on the followers it won and not only on the views it got.
    expect(table.get(`${metricKeys.videoSeries('cc', 's1')}|D#2026-10-10#youtube`)).toMatchObject({
      downloads: 40,
      subscribersGained: 3,
    });
  });

  it('keeps the night\u2019s views when a channel refuses the subscriber metric', async () => {
    const asked: string[] = [];
    const standard = fake.reports;
    fake.reports = (p) => {
      const perVideo = (p.get('filters') ?? '').startsWith('video==');
      if (perVideo) asked.push(p.get('metrics')!);
      if (perVideo && p.get('metrics')!.includes('subscribersGained')) {
        throw new Error('subscribersGained is not supported for this channel');
      }
      return standard(p);
    };

    await pullYouTube(deps(), RANGE);
    const day = table.get(`${metricKeys.videoSeries('cc', 's1')}|D#2026-10-10#youtube`);
    expect(day).toMatchObject({ downloads: 40 });
    expect(day!['subscribersGained']).toBeUndefined();
    // Asked once, refused once, then stopped asking for the rest of the run.
    expect(asked.filter((m) => m.includes('subscribersGained'))).toHaveLength(1);
    fake.reports = standard;
  });

  it('sums episodes and videos into the brand total, and leaves channel numbers out of it', async () => {
    await pullYouTube(deps(), RANGE);
    // 20 (episode v1) + 40 (short s1) on the 10th. The channel reported 70
    // views that day, including content DarkRelay knows nothing about.
    expect(table.get('S#cc#ALL|D#2026-10-10#youtube')).toMatchObject({ downloads: 60 });
    expect(
      table.get(`${metricKeys.outletSeries('cc', 'youtube')}|D#2026-10-10#youtube`),
    ).toMatchObject({
      outlet: 'youtube',
      views: 70,
      subscribersGained: 9,
      subscribersLost: 2,
      trafficSources: { SHORTS: 55, YT_SEARCH: 15 },
      formats: {
        short: { views: 40, watchSeconds: 1200 },
        long: { views: 30, watchSeconds: 6000 },
      },
    });
  });

  it('writes the brand row the dashboard switcher reads', async () => {
    await pullYouTube(deps(), RANGE);
    expect(table.get('SHOWS|S#cc')).toMatchObject({
      show: 'cc',
      title: 'Chaotic Commits',
      iconKey: 'cc/icon.jpg',
      outlets: [
        { id: 'rss', kind: 'rss', source: 'cloudfront', show: 'cc' },
        { id: 'youtube', kind: 'youtube', source: 'youtube', connection: 'cc' },
      ],
    });
  });

  it('pulls a brand that has a channel and no feed at all', async () => {
    const run = await pullYouTube(
      deps({
        brands: async () => [channelBrand],
        episodes: async () => {
          throw new Error('a brand with no feed must never be asked for episodes');
        },
      }),
      RANGE,
    );
    expect(run.shows).toEqual({ drjoanneskiles: { outlets: 1, videos: 2, days: 2 } });
    // Both videos are videos here: there is no feed to link them to.
    expect(
      table.has(`${metricKeys.videoSeries('drjoanneskiles', 'v1')}|D#2026-10-10#youtube`),
    ).toBe(true);
    expect(table.get('SHOWS|S#drjoanneskiles')).toMatchObject({ title: 'Dr. Joanne Skiles' });
  });

  it('records dormant uploads only when asked to list them', async () => {
    fake.uploads = [
      { videoId: 's1', title: 'A Short', publishedAt: '2026-10-08T12:00:00Z' },
      { videoId: 'old', title: 'Dormant', publishedAt: '2025-01-01T12:00:00Z' },
    ];
    fake.details.set('old', { duration: 'PT12M30S', title: 'Dormant' });

    await pullYouTube(deps(), RANGE);
    expect(table.has(`S#cc|${metricKeys.videoMeta('old')}`)).toBe(false);

    await pullYouTube(deps(), RANGE, { listUploads: true });
    expect(table.get(`S#cc|${metricKeys.videoMeta('old')}`)).toMatchObject({
      title: 'Dormant',
      format: 'long',
      durationSeconds: 750,
      downloadsTotal: 0,
    });
  });

  it('keeps going when one outlet cannot be reached', async () => {
    const run = await pullYouTube(
      deps({
        brands: async () => [channelBrand, podcastBrand],
        youtubeFor: async (connection) => {
          if (connection === 'drjoanneskiles') throw new Error('ParameterNotFound');
          return new YouTube('token', fake.endpoints);
        },
      }),
      RANGE,
    );
    expect(run.shows['drjoanneskiles']).toEqual({ outlets: 1, videos: 0, days: 0 });
    expect(run.shows['cc']).toMatchObject({ videos: 1 });
    // The unreachable brand still gets its row, so it appears in the switcher.
    expect(table.get('SHOWS|S#drjoanneskiles')).toBeDefined();
  });

  it('stores a retention curve for a video as well as an episode', async () => {
    await pullYouTube(deps(), RANGE);
    expect(table.get(`${metricKeys.videoSeries('cc', 's1')}|RET#youtube`)).toMatchObject({
      points: [
        { at: 0.01, watching: 1 },
        { at: 0.5, watching: 0.42 },
      ],
    });
  });

  it('re-reads the last week, ending yesterday', () => {
    expect(defaultRange(NOW)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });
});
