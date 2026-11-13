import {
  BrandConfig,
  ContentItem,
  accessFromGroups,
  layout,
  metricKeys,
  type ContentItemInput,
  type SchedulePlan,
} from '@darkrelay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Query } from '../src/shorts/history';
import { planContent, type PlannerDeps } from '../src/shorts/planner';
import { route, type ScheduleRequest } from '../src/shorts/schedule-api';
import { MemoryStore } from './memory-store';

const NOW = new Date('2026-11-12T10:00:00Z');

const cc = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'cc',
  name: 'Chaotic Commits',
  icon: { key: 'cc/icon-abc.jpg' },
  timezone: 'America/New_York',
  outlets: [
    { kind: 'rss', id: 'rss', show: 'cc' },
    { kind: 'youtube', id: 'youtube', connection: 'cc' },
  ],
});
const dr = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'drjoanneskiles',
  name: 'Dr. Joanne Skiles',
  outlets: [{ kind: 'youtube', id: 'youtube', connection: 'dr' }],
});

let store: MemoryStore;
let table: Record<string, unknown>[];
let logs: string[];

const query: Query = async (pk, sk) =>
  table.filter((item) => {
    if (item['pk'] !== pk) return false;
    const key = String(item['sk']);
    if (sk?.between) return key >= sk.between[0] && key <= sk.between[1];
    if (sk?.beginsWith) return key.startsWith(sk.beginsWith);
    return true;
  });

function deps(over: Partial<PlannerDeps> = {}): PlannerDeps {
  return {
    store,
    query,
    brands: async () => [cc, dr],
    episodes: async () => [],
    now: () => NOW,
    log: (m) => logs.push(m),
    ...over,
  };
}

const req = (over: Partial<ScheduleRequest> = {}): ScheduleRequest => ({
  method: 'GET',
  path: '/schedule',
  params: {},
  access: accessFromGroups(['admin']),
  ...over,
});

const viewer = accessFromGroups(['viewer:cc']);
const uploader = accessFromGroups(['uploader:cc']);

function seedContent(brand: string, over: Partial<ContentItemInput> = {}) {
  const item = ContentItem.parse({
    schemaVersion: 1,
    id: 'clip-aaaa1111',
    brand,
    kind: 'short',
    title: 'A Short',
    media: { key: layout.contentMedia(brand, 'clip-aaaa1111', 'clip.mp4') },
    publications: [{ outlet: 'youtube', state: 'planned', warnings: [] }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  });
  store.seed(layout.contentItem(brand, item.id), JSON.stringify(item));
  return item;
}

/** One settled video, so the scores rest on something. */
function seedHistory(brand: string) {
  table.push({
    pk: metricKeys.brandEpisodes(brand),
    sk: metricKeys.videoMeta('vid-1'),
    show: brand,
    videoId: 'vid-1',
    title: 'Video one',
    publishedAt: '2026-10-10T22:00:00Z',
    format: 'short',
    durationSeconds: 30,
  });
  table.push({
    pk: metricKeys.videoSeries(brand, 'vid-1'),
    sk: metricKeys.day('2026-10-10', 'youtube'),
    show: brand,
    date: '2026-10-10',
    source: 'youtube',
    downloads: 500,
    serverDownloads: 0,
    watchSeconds: 7500,
    apps: {},
    countries: {},
    devices: {},
  });
}

beforeEach(() => {
  store = new MemoryStore();
  table = [];
  logs = [];
});

describe('GET /schedule', () => {
  it('shows what is coming up across every brand the caller can see', async () => {
    seedContent('cc', { id: 'cc-soon0001', title: 'CC soon', publishAt: '2026-11-20T20:00:00Z' });
    seedContent('drjoanneskiles', {
      id: 'dr-soon0001',
      title: 'DR sooner',
      publishAt: '2026-11-18T20:00:00Z',
    });
    const res = await route(deps(), req());
    expect(res.statusCode).toBe(200);
    const body = res.body as { upcoming: { id: string; brandTitle: string }[]; brands: unknown[] };
    // In time order, not brand order: it is a calendar.
    expect(body.upcoming.map((u) => u.id)).toEqual(['dr-soon0001', 'cc-soon0001']);
    expect(body.upcoming[0]!.brandTitle).toBe('Dr. Joanne Skiles');
    expect(body.brands).toHaveLength(2);
  });

  it('leaves out brands the caller has no role for', async () => {
    seedContent('cc', { id: 'cc-soon0001', publishAt: '2026-11-20T20:00:00Z' });
    seedContent('drjoanneskiles', { id: 'dr-soon0001', publishAt: '2026-11-18T20:00:00Z' });
    const res = await route(deps(), req({ access: viewer }));
    const body = res.body as { upcoming: { id: string }[]; brands: { brand: string }[] };
    expect(body.upcoming.map((u) => u.id)).toEqual(['cc-soon0001']);
    expect(body.brands.map((b) => b.brand)).toEqual(['cc']);
  });

  it('keeps what went out in the last day, and drops older releases', async () => {
    seedContent('cc', { id: 'cc-yest0001', publishAt: '2026-11-12T02:00:00Z' });
    seedContent('cc', { id: 'cc-old00001', publishAt: '2026-11-01T02:00:00Z' });
    const body = (await route(deps(), req())).body as { upcoming: { id: string }[] };
    expect(body.upcoming.map((u) => u.id)).toEqual(['cc-yest0001']);
  });

  it('lists what has no slot separately, so it cannot be mistaken for scheduled', async () => {
    seedContent('cc', { id: 'cc-noslot01', title: 'Waiting' });
    const body = (await route(deps(), req())).body as {
      upcoming: unknown[];
      unscheduled: { id: string; title: string }[];
    };
    expect(body.upcoming).toEqual([]);
    expect(body.unscheduled).toEqual([
      expect.objectContaining({ id: 'cc-noslot01', title: 'Waiting' }),
    ]);
  });

  it('carries each item’s state and any warning, so a failure is visible', async () => {
    seedContent('cc', {
      id: 'cc-fail0001',
      publishAt: '2026-11-20T20:00:00Z',
      publications: [
        {
          outlet: 'youtube',
          state: 'failed',
          error: 'quotaExceeded',
          publishAt: '2026-11-20T20:00:00Z',
          warnings: ['Thumbnail: needs a verified channel'],
        },
      ],
    });
    const body = (await route(deps(), req())).body as {
      upcoming: { state: string; error?: string; warnings?: string[] }[];
    };
    expect(body.upcoming[0]).toMatchObject({
      state: 'failed',
      error: 'quotaExceeded',
      warnings: ['Thumbnail: needs a verified channel'],
    });
  });

  it('offers plans waiting for approval, and only to someone who may approve them', async () => {
    seedHistory('cc');
    seedContent('cc');
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2 });

    const asUploader = (await route(deps(), req({ access: uploader }))).body as {
      plans: { planId: string; items: number }[];
    };
    expect(asUploader.plans).toEqual([expect.objectContaining({ planId: plan.planId, items: 1 })]);

    // A viewer cannot approve anything, so is not offered the choice.
    const asViewer = (await route(deps(), req({ access: viewer }))).body as { plans: unknown[] };
    expect(asViewer.plans).toEqual([]);
  });

  it('stops offering a plan once it has been approved', async () => {
    seedHistory('cc');
    seedContent('cc');
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2 });
    await route(
      deps(),
      req({ method: 'POST', path: `/schedule/cc/plans/${plan.planId}/approve`, access: uploader }),
    );
    const body = (await route(deps(), req({ access: uploader }))).body as { plans: unknown[] };
    expect(body.plans).toEqual([]);
  });

  it('refuses anything but a read', async () => {
    expect((await route(deps(), req({ method: 'POST' }))).statusCode).toBe(405);
  });
});

describe('GET /schedule/{brand}/slots', () => {
  it('returns the whole week for a brand the caller can see', async () => {
    seedHistory('cc');
    const res = await route(deps(), req({ path: '/schedule/cc/slots', access: viewer }));
    expect(res.statusCode).toBe(200);
    const body = res.body as { slots: unknown[]; zone: string; samples: number };
    expect(body.slots).toHaveLength(168);
    expect(body.zone).toBe('America/New_York');
    expect(body.samples).toBe(1);
  });

  it('takes the format and window from the query string', async () => {
    seedHistory('cc');
    const res = await route(
      deps(),
      req({ path: '/schedule/cc/slots', params: { format: 'long', since: '400' } }),
    );
    // One Short in the history and a request for long-form: too few to score
    // alone, so it says it fell back rather than returning nothing.
    expect(res.body).toMatchObject({ fellBackToAllFormats: true });
  });

  it('ignores a format nobody reports', async () => {
    seedHistory('cc');
    const res = await route(
      deps(),
      req({ path: '/schedule/cc/slots', params: { format: 'nonsense' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatchObject({ fellBackToAllFormats: true });
  });

  it('refuses a brand the caller has no role for', async () => {
    const res = await route(
      deps(),
      req({ path: '/schedule/drjoanneskiles/slots', access: viewer }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('refuses a brand slug that is not one', async () => {
    expect((await route(deps(), req({ path: '/schedule/Not A Slug/slots' }))).statusCode).toBe(400);
  });
});

describe('plans', () => {
  it('lists a brand’s plans and reads one back', async () => {
    seedHistory('cc');
    seedContent('cc');
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2 });

    const list = (await route(deps(), req({ path: '/schedule/cc/plans', access: viewer })))
      .body as { plans: SchedulePlan[] };
    expect(list.plans.map((p) => p.planId)).toEqual([plan.planId]);

    const one = await route(
      deps(),
      req({ path: `/schedule/cc/plans/${plan.planId}`, access: viewer }),
    );
    expect(one.statusCode).toBe(200);
    expect(one.body).toMatchObject({ planId: plan.planId });
  });

  it('is a 404 for a plan that does not exist', async () => {
    const res = await route(deps(), req({ path: '/schedule/cc/plans/20261112000000-aaaaaa' }));
    expect(res.statusCode).toBe(404);
  });

  it('refuses a plan id that could not be one', async () => {
    expect((await route(deps(), req({ path: '/schedule/cc/plans/../../etc' }))).statusCode).toBe(
      400,
    );
  });

  it('builds a plan for an uploader, and writes no slot onto the content', async () => {
    seedHistory('cc');
    const item = seedContent('cc');
    const res = await route(
      deps(),
      req({
        method: 'POST',
        path: '/schedule/cc/plans',
        body: { weeks: 2, perWeek: 2 },
        access: uploader,
      }),
    );
    expect(res.statusCode).toBe(200);
    const plan = res.body as SchedulePlan;
    expect(plan.assignments).toHaveLength(1);
    expect(plan.perWeek).toBe(2);
    // Proposed, not taken: the content still has no slot.
    const stored = ContentItem.parse(store.json(layout.contentItem('cc', item.id)));
    expect(stored.publishAt).toBeUndefined();
  });

  it('will not let a viewer build or approve one', async () => {
    seedHistory('cc');
    seedContent('cc');
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2 });

    const build = await route(
      deps(),
      req({ method: 'POST', path: '/schedule/cc/plans', body: {}, access: viewer }),
    );
    expect(build.statusCode).toBe(403);
    expect(build.body).toMatchObject({ error: expect.stringContaining('uploader role') });

    const approve = await route(
      deps(),
      req({
        method: 'POST',
        path: `/schedule/cc/plans/${plan.planId}/approve`,
        access: viewer,
      }),
    );
    expect(approve.statusCode).toBe(403);
    // And the content is untouched.
    expect(
      ContentItem.parse(store.json(layout.contentItem('cc', 'clip-aaaa1111'))).publishAt,
    ).toBeUndefined();
  });

  it('refuses a request body it does not understand', async () => {
    const bad = await route(
      deps(),
      req({
        method: 'POST',
        path: '/schedule/cc/plans',
        body: { weeks: 500 },
        access: uploader,
      }),
    );
    expect(bad.statusCode).toBe(400);

    const unknown = await route(
      deps(),
      req({
        method: 'POST',
        path: '/schedule/cc/plans',
        body: { somethingElse: true },
        access: uploader,
      }),
    );
    expect(unknown.statusCode).toBe(400);
  });

  it('turns a refusal from the planner into a 400 with its reason', async () => {
    const feedOnly = BrandConfig.parse({
      schemaVersion: 1,
      slug: 'cc',
      name: 'Feed only',
      outlets: [{ kind: 'rss', id: 'rss', show: 'cc' }],
    });
    const res = await route(
      deps({ brands: async () => [feedOnly] }),
      req({ method: 'POST', path: '/schedule/cc/plans', body: {}, access: uploader }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('no YouTube outlet') });
  });
});

describe('approval', () => {
  it('is the step that puts the times on the content', async () => {
    seedHistory('cc');
    seedContent('cc');
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2 });
    const res = await route(
      deps(),
      req({
        method: 'POST',
        path: `/schedule/cc/plans/${plan.planId}/approve`,
        access: uploader,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: [{ id: 'clip-aaaa1111' }] });
    const stored = ContentItem.parse(store.json(layout.contentItem('cc', 'clip-aaaa1111')));
    expect(stored.publishAt).toBe(plan.assignments[0]!.publishAt);
    // Still nothing on YouTube: the sweep does that when the slot is close.
    expect(stored.publications[0]!.state).toBe('planned');
  });

  it('says so when a plan has already been taken', async () => {
    seedHistory('cc');
    seedContent('cc');
    const plan = await planContent(deps(), { brand: 'cc', weeks: 2 });
    const approve = () =>
      route(
        deps(),
        req({
          method: 'POST',
          path: `/schedule/cc/plans/${plan.planId}/approve`,
          access: uploader,
        }),
      );
    expect((await approve()).statusCode).toBe(200);
    const again = await approve();
    expect(again.statusCode).toBe(400);
    expect(again.body).toMatchObject({ error: expect.stringContaining('already approved') });
  });
});

describe('routing', () => {
  it('is a 404 for anything it does not serve', async () => {
    for (const path of ['/', '/other', '/schedule/cc/nonsense', '/schedule/cc/plans/a/b/c']) {
      expect((await route(deps(), req({ path }))).statusCode).toBe(404);
    }
  });

  it('refuses a write to a read-only path', async () => {
    const res = await route(deps(), req({ method: 'POST', path: '/schedule/cc/slots' }));
    expect(res.statusCode).toBe(405);
  });
});
