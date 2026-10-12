import { EpisodeManifest, ShowConfig, metricKeys, type MetricItem, YouTube } from '@darkrelay/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRange, pullYouTube, type YouTubeAnalyticsDeps } from '../src/youtube/analytics';
import { FakeYouTube } from './fake-youtube';

let fake: FakeYouTube;
beforeAll(async () => {
  fake = await new FakeYouTube().start();
});
afterAll(() => fake.stop());

const show = ShowConfig.parse({
  schemaVersion: 1,
  slug: 'cc',
  status: 'live',
  title: 'Chaotic Commits',
  description: 'd',
  link: 'https://example.com',
  language: 'en',
  author: 'a',
  owner: { name: 'a', email: 'a@example.com' },
  image: { key: 'cc/cover.jpg' },
  categories: [{ text: 'Technology' }],
  explicit: false,
  podcastGuid: '23f35153-ba05-5a2c-9d23-8c51b427723c',
  youtube: { connection: 'cc' },
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

describe('pullYouTube', () => {
  it('writes daily views and watch time per episode, show totals, retention and summaries', async () => {
    fake.reports = (p) => {
      const video = p.get('filters')!.split('==')[1];
      if (p.get('dimensions') === 'elapsedVideoTimeRatio') {
        return {
          columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }],
          rows: [
            [0.01, 1.0],
            [0.5, 0.42],
          ],
        };
      }
      const views = video === 'v1' ? 10 : 3;
      return {
        columnHeaders: [{ name: 'day' }, { name: 'views' }, { name: 'estimatedMinutesWatched' }],
        rows: [
          ['2026-10-09', views, 30.5],
          ['2026-10-10', views * 2, 61],
        ],
      };
    };
    const table = new Map<string, Record<string, unknown>>();
    const deps: YouTubeAnalyticsDeps = {
      shows: async () => [show],
      episodes: async () => [ep('e1', 'v1'), ep('e2', 'v2'), ep('not-on-youtube')],
      youtubeFor: async () => new YouTube('token', fake.endpoints),
      put: async (items) => {
        for (const i of items) table.set(`${i['pk']}|${i['sk']}`, i);
      },
      episodeSeries: async (s, id) =>
        [...table.values()].filter(
          (i) => i['pk'] === metricKeys.episodeSeries(s, id),
        ) as unknown as MetricItem[],
      now: () => new Date('2026-10-12T04:00:00Z'),
      log: () => {},
    };

    const run = await pullYouTube(deps, { from: '2026-10-05', to: '2026-10-11' });
    expect(run.shows).toEqual({ cc: { videos: 2, days: 2 } });

    const e1 = [...table.values()].find(
      (i) =>
        i['sk'] === 'D#2026-10-10#youtube' &&
        i['title'] === undefined &&
        String(i['pk']).includes('#E#'),
    );
    expect(e1).toMatchObject({
      source: 'youtube',
      downloads: 20,
      watchSeconds: 3660,
      apps: { YouTube: 20 },
    });
    expect(table.get('S#cc#ALL|D#2026-10-10#youtube')).toMatchObject({
      downloads: 26,
      watchSeconds: 7320,
    });

    const summaries = [...table.values()].filter(
      (i) => i['pk'] === 'S#cc' && String(i['sk']).startsWith('E#'),
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s['youtubeVideoId'] === 'v1')).toMatchObject({
      downloads7: 30,
      downloadsTotal: 30,
      watchSecondsTotal: 5490,
    });
    const retention = [...table.values()].find((i) => i['sk'] === 'RET#youtube');
    expect(retention).toMatchObject({
      points: [
        { at: 0.01, watching: 1 },
        { at: 0.5, watching: 0.42 },
      ],
    });
    expect(table.get('RUN#youtube|2026-10-11')).toBeDefined();
  });

  it('re-reads the last week, ending yesterday', () => {
    expect(defaultRange(new Date('2026-10-12T04:00:00Z'))).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
  });
});
