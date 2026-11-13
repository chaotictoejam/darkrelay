import {
  BrandConfig,
  ContentItem,
  episodeId,
  layout,
  metricKeys,
  publicationFor,
  dueForUpload,
  type ContentItemInput,
  type EpisodeManifest,
  type SchedulePlan,
} from '@darkrelay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTLED_DAYS, loadHistory, type HistoryDeps } from '../src/shorts/history';
import {
  approvePlan,
  listPlans,
  loadPlan,
  planContent,
  slotScores,
  type PlannerDeps,
} from '../src/shorts/planner';
import { MemoryStore } from './memory-store';

const NOW = new Date('2026-11-12T10:00:00Z');
const GUID = 'ep-guid-1';
const PARENT = episodeId(GUID);

const brand = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'cc',
  name: 'Chaotic Commits',
  timezone: 'America/New_York',
  outlets: [
    { kind: 'rss', id: 'rss', show: 'cc' },
    { kind: 'youtube', id: 'youtube', connection: 'cc' },
  ],
});

/** Just enough of an episode for the planner: its guid and when it is out. */
const episode = (pubDate: string): EpisodeManifest =>
  ({ guid: GUID, title: 'Episode 1', pubDate }) as EpisodeManifest;

let store: MemoryStore;
let table: Record<string, unknown>[];
let logs: string[];

/** The metrics table, as the planner reads it: one partition at a time. */
const query: HistoryDeps['query'] = async (pk, sk) => {
  return table.filter((item) => {
    if (item['pk'] !== pk) return false;
    const key = String(item['sk']);
    if (sk?.between) return key >= sk.between[0] && key <= sk.between[1];
    if (sk?.beginsWith) return key.startsWith(sk.beginsWith);
    return true;
  });
};

function deps(over: Partial<PlannerDeps> = {}): PlannerDeps {
  return {
    store,
    query,
    brands: async () => [brand],
    episodes: async () => [],
    now: () => NOW,
    log: (m) => logs.push(m),
    ...over,
  };
}

/** A video on the channel, with its first three days of numbers. */
function seedVideo(
  videoId: string,
  publishedAt: string,
  days: { views: number; watchSeconds?: number; subscribersGained?: number }[],
  over: Record<string, unknown> = {},
) {
  table.push({
    pk: metricKeys.brandEpisodes('cc'),
    sk: metricKeys.videoMeta(videoId),
    show: 'cc',
    videoId,
    title: `Video ${videoId}`,
    publishedAt,
    format: 'short',
    durationSeconds: 30,
    ...over,
  });
  const start = Date.parse(publishedAt.slice(0, 10) + 'T00:00:00Z');
  days.forEach((day, i) => {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    table.push({
      pk: metricKeys.videoSeries('cc', videoId),
      sk: metricKeys.day(date, 'youtube'),
      show: 'cc',
      videoId,
      date,
      source: 'youtube',
      downloads: day.views,
      serverDownloads: 0,
      watchSeconds: day.watchSeconds ?? day.views * 15,
      ...(day.subscribersGained === undefined ? {} : { subscribersGained: day.subscribersGained }),
      apps: {},
      countries: {},
      devices: {},
    });
  });
}

function seedContent(over: Partial<ContentItemInput> = {}) {
  const item = ContentItem.parse({
    schemaVersion: 1,
    id: 'clip-aaaa1111',
    brand: 'cc',
    kind: 'short',
    title: 'A Short',
    media: { key: layout.contentMedia('cc', 'clip-aaaa1111', 'clip.mp4') },
    publications: [{ outlet: 'youtube', state: 'planned', warnings: [] }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  });
  store.seed(layout.contentItem('cc', item.id), JSON.stringify(item));
  return item;
}

beforeEach(() => {
  store = new MemoryStore();
  table = [];
  logs = [];
});

describe('loadHistory', () => {
  it('reads each video and sums its first three days of YouTube numbers', async () => {
    seedVideo('vid-1', '2026-10-10T22:00:00Z', [
      { views: 100, subscribersGained: 2 },
      { views: 50, subscribersGained: 1 },
      { views: 25, subscribersGained: 0 },
      // A fourth day exists but is outside the 72-hour window.
      { views: 1000, subscribersGained: 50 },
    ]);
    const history = await loadHistory(deps(), 'cc');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: 'vid-1',
      title: 'Video vid-1',
      publishedAt: '2026-10-10T22:00:00Z',
      format: 'short',
      views72h: 175,
      subscribersGained72h: 3,
      durationSeconds: 30,
    });
  });

  it('ignores anything a feed counted: a download says nothing about an hour', async () => {
    seedVideo('vid-1', '2026-10-10T22:00:00Z', [{ views: 100 }]);
    table.push({
      pk: metricKeys.videoSeries('cc', 'vid-1'),
      sk: metricKeys.day('2026-10-10', 'cloudfront'),
      show: 'cc',
      date: '2026-10-10',
      source: 'cloudfront',
      downloads: 9999,
      serverDownloads: 0,
      apps: {},
      countries: {},
      devices: {},
    });
    const history = await loadHistory(deps(), 'cc');
    expect(history[0]!.views72h).toBe(100);
  });

  it('leaves out a video too new to have its three days yet', async () => {
    seedVideo('settled', '2026-11-01T22:00:00Z', [{ views: 100 }]);
    seedVideo('fresh', '2026-11-11T22:00:00Z', [{ views: 100 }]);
    const history = await loadHistory(deps(), 'cc');
    expect(history.map((h) => h.id)).toEqual(['settled']);
    expect(SETTLED_DAYS).toBe(3);
  });

  it('leaves subscribers unset when the channel never reported them', async () => {
    seedVideo('vid-1', '2026-10-10T22:00:00Z', [{ views: 100 }]);
    const history = await loadHistory(deps(), 'cc');
    expect(history[0]!.subscribersGained72h).toBeUndefined();
  });

  it('counts an episode as long-form, and only if it went to YouTube', async () => {
    const id = episodeId('ep-a');
    table.push({
      pk: metricKeys.brandEpisodes('cc'),
      sk: metricKeys.episodeMeta(id),
      show: 'cc',
      episodeId: id,
      guid: 'ep-a',
      title: 'An episode',
      pubDate: '2026-10-06T17:00:00Z',
      youtubeVideoId: 'yt-a',
    });
    table.push({
      pk: metricKeys.episodeSeries('cc', id),
      sk: metricKeys.day('2026-10-06', 'youtube'),
      show: 'cc',
      date: '2026-10-06',
      source: 'youtube',
      downloads: 400,
      serverDownloads: 0,
      watchSeconds: 60_000,
      apps: {},
      countries: {},
      devices: {},
    });
    // A second episode that was never uploaded: no video, no slot evidence.
    const other = episodeId('ep-b');
    table.push({
      pk: metricKeys.brandEpisodes('cc'),
      sk: metricKeys.episodeMeta(other),
      show: 'cc',
      episodeId: other,
      guid: 'ep-b',
      title: 'Audio only',
      pubDate: '2026-10-07T17:00:00Z',
    });

    const history = await loadHistory(deps(), 'cc');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id, format: 'long', views72h: 400 });
  });

  it('has nothing to say about a brand with no history', async () => {
    expect(await loadHistory(deps(), 'cc')).toEqual([]);
  });
});

describe('slotScores', () => {
  it('scores the week from the brand’s own clock', async () => {
    seedVideo('vid-1', '2026-10-10T22:00:00Z', [{ views: 100 }]);
    // No zone asked for: the brand's own is used, not the fallback.
    const scores = await slotScores(deps(), 'cc', { fallbackZone: 'UTC' });
    expect(scores.zone).toBe('America/New_York');
    expect(scores.slots).toHaveLength(168);
    expect(scores.samples).toBe(1);
    // 22:00 UTC on 10 October is 18:00 on the Saturday in New York.
    expect(scores.slots.find((s) => s.samples)!.key).toBe('6-18');
  });
});

describe('planContent', () => {
  it('plans the content with no slot, stores the plan, and changes nothing else', async () => {
    const item = seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2, perWeek: 2 });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.brand).toBe('cc');
    expect(plan.outlet).toBe('youtube');
    expect(plan.zone).toBe('America/New_York');
    // Stored where it can be read again.
    expect(await loadPlan(store, 'cc', plan.planId)).toEqual(plan);
    // The content itself is untouched: no slot, still only planned.
    const stored = ContentItem.parse(store.json(layout.contentItem('cc', item.id)));
    expect(stored.publishAt).toBeUndefined();
    expect(publicationFor(stored, 'youtube')!.state).toBe('planned');
  });

  it('plans in the order the batch was written, not by id', async () => {
    seedContent({ id: 'zzz-00000001', title: 'First in the manifest', seq: 0 });
    seedContent({ id: 'aaa-00000002', title: 'Second in the manifest', seq: 1 });
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2, perWeek: 2 });
    expect(plan.assignments.map((a) => a.title)).toEqual([
      'First in the manifest',
      'Second in the manifest',
    ]);
  });

  it('will not schedule a clip before the episode it came from', async () => {
    seedContent({ id: 'clip-aaaa1111', parentId: PARENT, seq: 0 });
    const future = '2026-12-05T13:00:00Z';
    const plan = await planContent(deps({ episodes: async () => [episode(future)] }), {
      brand: 'cc',
      weeks: 6,
      perWeek: 3,
    });
    expect(plan.assignments).toHaveLength(1);
    expect(Date.parse(plan.assignments[0]!.publishAt)).toBeGreaterThanOrEqual(Date.parse(future));
  });

  it('leaves out content already published on that channel', async () => {
    seedContent({
      id: 'clip-done0001',
      publications: [{ outlet: 'youtube', state: 'published', externalId: 'yt-1', warnings: [] }],
    });
    seedContent({ id: 'clip-todo0001' });
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2, perWeek: 2 });
    expect(plan.assignments.map((a) => a.id)).toEqual(['clip-todo0001']);
  });

  it('refuses a brand with no YouTube outlet rather than planning into nothing', async () => {
    const feedOnly = BrandConfig.parse({
      schemaVersion: 1,
      slug: 'cc',
      name: 'Feed only',
      outlets: [{ kind: 'rss', id: 'rss', show: 'cc' }],
    });
    await expect(
      planContent(deps({ brands: async () => [feedOnly] }), { brand: 'cc' }),
    ).rejects.toThrow(/no YouTube outlet/);
  });

  it('refuses a brand it has never heard of', async () => {
    await expect(planContent(deps(), { brand: 'nope' })).rejects.toThrow(/No brand "nope"/);
  });

  it("keeps a brand's own clock ahead of the deployment's, and a request ahead of both", async () => {
    seedContent();
    // The brand says New York; the deployment says Los Angeles.
    const byBrand = await planContent(deps(), { brand: 'cc', fallbackZone: 'America/Los_Angeles' });
    expect(byBrand.zone).toBe('America/New_York');

    // A brand with no timezone of its own takes the deployment's.
    const noZone = BrandConfig.parse({ ...brand, timezone: undefined });
    const byDeployment = await planContent(deps({ brands: async () => [noZone] }), {
      brand: 'cc',
      fallbackZone: 'America/Los_Angeles',
    });
    expect(byDeployment.zone).toBe('America/Los_Angeles');

    // An explicit request wins over both.
    const byRequest = await planContent(deps(), {
      brand: 'cc',
      zone: 'Europe/London',
      fallbackZone: 'America/Los_Angeles',
    });
    expect(byRequest.zone).toBe('Europe/London');
  });

  it('opens the window after the upload lead, never today', async () => {
    seedContent();
    const plan = await planContent(deps(), { brand: 'cc', leadDays: 5, weeks: 2 });
    expect(Date.parse(plan.from)).toBe(NOW.getTime() + 5 * 86_400_000);
    expect(Date.parse(plan.assignments[0]!.publishAt)).toBeGreaterThan(Date.parse(plan.from));
  });
});

describe('approvePlan', () => {
  it('is what puts the times on the content, and still uploads nothing', async () => {
    const item = seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2, perWeek: 2 });
    const result = await approvePlan(deps(), 'cc', plan.planId);

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    const stored = ContentItem.parse(store.json(layout.contentItem('cc', item.id)));
    expect(stored.publishAt).toBe(plan.assignments[0]!.publishAt);
    const publication = publicationFor(stored, 'youtube')!;
    expect(publication.publishAt).toBe(plan.assignments[0]!.publishAt);
    // Nothing has been sent anywhere: that is the sweep's job, later.
    expect(publication.state).toBe('planned');
    expect(publication.externalId).toBeUndefined();
    expect(stored.publications).toHaveLength(1);
  });

  it('hands the item to the upload sweep once its slot is close', async () => {
    seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 1, perWeek: 1 });
    await approvePlan(deps(), 'cc', plan.planId);
    const stored = ContentItem.parse(store.json(layout.contentItem('cc', 'clip-aaaa1111')));

    const slot = Date.parse(stored.publishAt!);
    expect(dueForUpload(stored, 'youtube', new Date(slot - 10 * 86_400_000), 3)).toBe(false);
    expect(dueForUpload(stored, 'youtube', new Date(slot - 2 * 86_400_000), 3)).toBe(true);
  });

  it('records the approval on the plan itself', async () => {
    seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 1, perWeek: 1 });
    const result = await approvePlan(deps(), 'cc', plan.planId);
    expect(result.plan.approvedAt).toBe(NOW.toISOString());
    expect(result.plan.applied).toEqual([
      { id: 'clip-aaaa1111', publishAt: plan.assignments[0]!.publishAt },
    ]);
    const reread = await loadPlan(store, 'cc', plan.planId);
    expect(reread!.approvedAt).toBe(NOW.toISOString());
  });

  it('refuses to approve the same plan twice', async () => {
    seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 1, perWeek: 1 });
    await approvePlan(deps(), 'cc', plan.planId);
    await expect(approvePlan(deps(), 'cc', plan.planId)).rejects.toThrow(/already approved/);
  });

  it('refuses a plan that does not exist', async () => {
    await expect(approvePlan(deps(), 'cc', 'nope')).rejects.toThrow(/No plan "nope"/);
  });

  it('skips anything that went out between planning and approval', async () => {
    const item = seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 1, perWeek: 1 });
    // It was published by hand in the meantime.
    store.seed(
      layout.contentItem('cc', item.id),
      JSON.stringify({
        ...item,
        publications: [{ outlet: 'youtube', state: 'published', externalId: 'yt-9', warnings: [] }],
      }),
    );
    const result = await approvePlan(deps(), 'cc', plan.planId);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ id: item.id, reason: 'already published' }]);
  });

  it('skips content that has been deleted', async () => {
    const item = seedContent();
    const plan = await planContent(deps(), { brand: 'cc', weeks: 1, perWeek: 1 });
    await store.delete([layout.contentItem('cc', item.id)]);
    const result = await approvePlan(deps(), 'cc', plan.planId);
    expect(result.skipped).toEqual([{ id: item.id, reason: 'the content is gone' }]);
  });
});

describe('listPlans', () => {
  it('lists a brand’s plans, newest first', async () => {
    seedContent();
    const first = await planContent(deps(), { brand: 'cc', weeks: 1 });
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await planContent(deps({ now: () => later }), { brand: 'cc', weeks: 1 });
    const plans = (await listPlans(store, 'cc')) as SchedulePlan[];
    expect(plans.map((p) => p.planId)).toEqual([second.planId, first.planId]);
  });

  it('has nothing to list for a brand that has never planned', async () => {
    expect(await listPlans(store, 'cc')).toEqual([]);
  });
});
