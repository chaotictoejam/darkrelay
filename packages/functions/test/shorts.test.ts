import {
  BrandConfig,
  ContentItem,
  SHORTS_MANIFEST_FILE,
  YouTube,
  episodeId,
  layout,
  type ShortsManifestInput,
} from '@darkrelay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestBatch, type IngestDeps } from '../src/shorts/ingest';
import { sweepDue, uploadContent, uploadsToday, type ShortsUploadDeps } from '../src/shorts/upload';
import { FakeYouTube } from './fake-youtube';
import { MemoryStore } from './memory-store';

const NOW = new Date('2026-11-12T10:00:00Z');
const BATCH = '20261112100000-abcdef';
const GUID = 'ep-guid-1';

const brand = BrandConfig.parse({
  schemaVersion: 1,
  slug: 'cc',
  name: 'Chaotic Commits',
  outlets: [
    { kind: 'rss', id: 'rss', show: 'cc' },
    { kind: 'youtube', id: 'youtube', connection: 'cc' },
  ],
});

let store: MemoryStore;
let logs: string[];

function seedBatch(manifest: ShortsManifestInput, files = ['clip-01.mp4']) {
  const prefix = layout.inboxPrefix('cc', BATCH);
  for (const file of files) store.seed(prefix + file, `bytes of ${file}`);
  store.seed(prefix + SHORTS_MANIFEST_FILE, JSON.stringify(manifest));
}

function ingestDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    store,
    loadBrand: async () => brand,
    episodeGuids: async () => [GUID],
    now: () => NOW,
    log: (m) => logs.push(m),
    ...over,
  };
}

const manifest = (over: Partial<ShortsManifestInput> = {}): ShortsManifestInput => ({
  schemaVersion: 1,
  shorts: [{ file: 'clip-01.mp4', title: 'Clip one' }],
  ...over,
});

beforeEach(() => {
  store = new MemoryStore();
  logs = [];
});

describe('ingestBatch', () => {
  it('keeps the order the manifest was written in, because clips are a sequence', async () => {
    seedBatch(
      manifest({
        shorts: [
          { file: 'part-1.mp4', title: 'Part one' },
          { file: 'part-2.mp4', title: 'Part two' },
          { file: 'part-3.mp4', title: 'Part three' },
        ],
      }),
      ['part-1.mp4', 'part-2.mp4', 'part-3.mp4'],
    );
    const result = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(result.status).toBe('ingested');
    const order = result.items.map((i) => {
      const stored = ContentItem.parse(store.json(layout.contentItem('cc', i.id)));
      return { title: stored.title, seq: stored.seq };
    });
    expect(order).toEqual([
      { title: 'Part one', seq: 0 },
      { title: 'Part two', seq: 1 },
      { title: 'Part three', seq: 2 },
    ]);
  });

  it('records each Short, copies its media out of the inbox, and schedules nothing', async () => {
    seedBatch(
      manifest({
        shorts: [
          {
            file: 'clip-01.mp4',
            title: 'Clip one',
            publishAt: '2026-11-20T15:00:00Z',
            parentId: GUID,
          },
        ],
        defaults: { tags: ['chaotic'] },
      }),
    );
    const result = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(result.status).toBe('ingested');
    expect(result.outlet).toBe('youtube');

    const id = result.items[0]!.id;
    const item = ContentItem.parse(store.json(layout.contentItem('cc', id)));
    expect(item).toMatchObject({
      kind: 'short',
      title: 'Clip one',
      tags: ['chaotic'],
      parentId: episodeId(GUID),
      publishAt: '2026-11-20T15:00:00Z',
      media: { key: layout.contentMedia('cc', id, 'clip-01.mp4') },
    });
    // The media leaves the inbox, which expires after a week; a slot can be months out.
    expect(store.text(layout.contentMedia('cc', id, 'clip-01.mp4'))).toBe('bytes of clip-01.mp4');
    expect(item.publications).toEqual([
      expect.objectContaining({ outlet: 'youtube', state: 'planned' }),
    ]);
  });

  it('writes nothing at all when one item is wrong', async () => {
    seedBatch(
      manifest({
        shorts: [
          { file: 'clip-01.mp4', title: 'Fine' },
          { file: 'missing.mp4', title: 'Not uploaded' },
        ],
      }),
    );
    const result = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(result.status).toBe('rejected');
    expect(result.errors.join()).toMatch(/no such file in the batch/);
    expect(await store.list(layout.contentPrefix('cc'))).toEqual([]);
    expect(store.json(layout.inboxStatus('cc', BATCH))).toMatchObject({ status: 'rejected' });
  });

  it('rejects a parentId that names no episode', async () => {
    seedBatch(manifest({ shorts: [{ file: 'clip-01.mp4', title: 'A', parentId: 'nope' }] }));
    const result = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(result.errors.join()).toMatch(/no episode with guid or id "nope"/i);
  });

  it('takes a parent by episode id as well as by guid, and allows none', async () => {
    seedBatch(
      manifest({
        shorts: [{ file: 'clip-01.mp4', title: 'A', parentId: episodeId(GUID) }],
      }),
    );
    const byId = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(byId.status).toBe('ingested');

    store = new MemoryStore();
    seedBatch(manifest());
    const standalone = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(standalone.status).toBe('ingested');
    const item = ContentItem.parse(store.json(layout.contentItem('cc', standalone.items[0]!.id)));
    expect(item.parentId).toBeUndefined();
  });

  it('refuses a brand with no channel to publish to', async () => {
    seedBatch(manifest());
    const feedOnly = BrandConfig.parse({
      schemaVersion: 1,
      slug: 'cc',
      name: 'cc',
      outlets: [{ kind: 'rss', id: 'rss', show: 'cc' }],
    });
    const result = await ingestBatch(ingestDeps({ loadBrand: async () => feedOnly }), 'cc', BATCH);
    expect(result.errors.join()).toMatch(/no YouTube outlet/);
  });

  it('refuses a manifest that names a different brand', async () => {
    seedBatch(manifest({ brand: 'drjoanneskiles' }));
    const result = await ingestBatch(ingestDeps(), 'cc', BATCH);
    expect(result.errors.join()).toMatch(/uploaded under "cc"/);
  });

  it('re-ingesting refreshes the copy but never rewinds what is already out', async () => {
    seedBatch(manifest({ shorts: [{ file: 'clip-01.mp4', title: 'First title', id: 'fixed' }] }));
    await ingestBatch(ingestDeps(), 'cc', BATCH);
    const key = layout.contentItem('cc', 'fixed');
    const published = {
      ...ContentItem.parse(store.json(key)),
      publications: [
        {
          outlet: 'youtube',
          state: 'published' as const,
          externalId: 'v1',
          uploadedAt: NOW.toISOString(),
          warnings: [],
        },
      ],
    };
    store.seed(key, JSON.stringify(published));

    seedBatch(manifest({ shorts: [{ file: 'clip-01.mp4', title: 'Second title', id: 'fixed' }] }));
    await ingestBatch(ingestDeps(), 'cc', BATCH);
    const after = ContentItem.parse(store.json(key));
    expect(after.title).toBe('Second title');
    expect(after.publications[0]).toMatchObject({ state: 'published', externalId: 'v1' });
  });
});

describe('uploadContent', () => {
  let fake: FakeYouTube;
  beforeAll(async () => {
    fake = await new FakeYouTube().start();
  });
  afterAll(() => fake.stop());

  function uploadDeps(over: Partial<ShortsUploadDeps> = {}): ShortsUploadDeps {
    return {
      store,
      brands: async () => [brand],
      loadShow: async () => undefined,
      youtubeFor: async () => new YouTube('token', fake.endpoints),
      continueLater: async () => {},
      timeLeftMs: () => 600_000,
      now: () => NOW,
      log: (m) => logs.push(m),
      ...over,
    };
  }

  const seedItem = (over: Record<string, unknown> = {}) => {
    const item = ContentItem.parse({
      schemaVersion: 1,
      id: 'clip-1',
      brand: 'cc',
      kind: 'short',
      title: 'Clip one',
      description: 'Watch this',
      tags: ['chaotic'],
      media: { key: layout.contentMedia('cc', 'clip-1', 'clip.mp4') },
      publishAt: '2026-11-14T15:00:00Z',
      publications: [
        { outlet: 'youtube', state: 'planned', publishAt: '2026-11-14T15:00:00Z', warnings: [] },
      ],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...over,
    });
    store.seed(layout.contentItem('cc', item.id), JSON.stringify(item));
    store.seed((item.media as { key: string }).key, 'video bytes');
    return item;
  };

  it('uploads a future slot as a private video with publishAt', async () => {
    seedItem();
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1' })).toBe('uploaded');
    const [videoId, video] = [...fake.videos.entries()].at(-1)!;
    // YouTube only schedules private videos; it makes them public at publishAt.
    expect(video.metadata.status).toMatchObject({
      privacyStatus: 'private',
      publishAt: '2026-11-14T15:00:00.000Z',
    });
    expect(video.metadata.snippet).toMatchObject({ title: 'Clip one', description: 'Watch this' });
    expect(video.bytes.toString()).toBe('video bytes');

    const item = ContentItem.parse(store.json(layout.contentItem('cc', 'clip-1')));
    expect(item.publications[0]).toMatchObject({
      state: 'scheduled',
      externalId: videoId,
      sentPublishAt: '2026-11-14T15:00:00Z',
      uploadedAt: NOW.toISOString(),
    });
  });

  it('publishes a slot that has already passed at once', async () => {
    seedItem({
      publishAt: '2026-11-01T15:00:00Z',
      publications: [
        { outlet: 'youtube', state: 'planned', publishAt: '2026-11-01T15:00:00Z', warnings: [] },
      ],
    });
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1' })).toBe('uploaded');
    const video = [...fake.videos.values()].at(-1)!;
    expect(video.metadata.status).toMatchObject({ privacyStatus: 'public' });
    expect(video.metadata.status['publishAt']).toBeUndefined();
  });

  it('does nothing to an item already sent, and moves one whose slot changed', async () => {
    const uploaded = seedItem({
      publications: [
        {
          outlet: 'youtube',
          state: 'scheduled',
          externalId: 'vid9',
          publishAt: '2026-11-14T15:00:00Z',
          sentPublishAt: '2026-11-14T15:00:00Z',
          warnings: [],
        },
      ],
    });
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1' })).toBe('already');

    store.seed(
      layout.contentItem('cc', 'clip-1'),
      JSON.stringify({ ...uploaded, publishAt: '2026-11-18T15:00:00Z' }),
    );
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1' })).toBe('rescheduled');
    expect(fake.statusUpdates.at(-1)).toMatchObject({
      id: 'vid9',
      status: { privacyStatus: 'private', publishAt: '2026-11-18T15:00:00Z' },
    });
    const item = ContentItem.parse(store.json(layout.contentItem('cc', 'clip-1')));
    expect(item.publications[0]).toMatchObject({ sentPublishAt: '2026-11-18T15:00:00Z' });
  });

  it('refuses to upload something with no slot unless forced', async () => {
    seedItem({ publishAt: undefined, publications: [] });
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1' })).toBe('no-slot');
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1', force: true })).toBe(
      'uploaded',
    );
  });

  it('records a failure on the item instead of losing it', async () => {
    seedItem({ media: { key: 'catalog/cc/content/clip-1/missing.mp4' } });
    store.objects.delete('catalog/cc/content/clip-1/missing.mp4');
    expect(await uploadContent(uploadDeps(), { brand: 'cc', id: 'clip-1' })).toBe('failed');
    const item = ContentItem.parse(store.json(layout.contentItem('cc', 'clip-1')));
    expect(item.publications[0]).toMatchObject({ state: 'failed' });
    expect(item.publications[0]!.error).toMatch(/missing/i);
  });

  it('hands off when the Lambda is about to run out of time', async () => {
    seedItem();
    const handoffs: unknown[] = [];
    const outcome = await uploadContent(
      uploadDeps({ timeLeftMs: () => 1000, continueLater: async (e) => void handoffs.push(e) }),
      { brand: 'cc', id: 'clip-1' },
    );
    expect(outcome).toBe('continuing');
    expect(handoffs).toEqual([{ brand: 'cc', id: 'clip-1', continuation: true }]);
  });
});

describe('sweepDue', () => {
  let fake: FakeYouTube;
  beforeAll(async () => {
    fake = await new FakeYouTube().start();
  });
  afterAll(() => fake.stop());

  function seedMany(slots: (string | undefined)[]) {
    slots.forEach((publishAt, i) => {
      const id = `clip-${i}`;
      store.seed(
        layout.contentItem('cc', id),
        JSON.stringify(
          ContentItem.parse({
            schemaVersion: 1,
            id,
            brand: 'cc',
            kind: 'short',
            title: `Clip ${i}`,
            media: { key: layout.contentMedia('cc', id, 'clip.mp4') },
            publishAt,
            publications: [{ outlet: 'youtube', state: 'planned', publishAt, warnings: [] }],
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }),
        ),
      );
      store.seed(layout.contentMedia('cc', id, 'clip.mp4'), `bytes ${i}`);
    });
  }

  const deps = (): ShortsUploadDeps => ({
    store,
    brands: async () => [brand],
    loadShow: async () => undefined,
    youtubeFor: async () => new YouTube('token', fake.endpoints),
    continueLater: async () => {},
    timeLeftMs: () => 600_000,
    now: () => NOW,
    log: (m) => logs.push(m),
  });

  it('uploads what is close, leaves the rest, and takes the nearest slot first', async () => {
    seedMany([
      '2026-11-20T15:00:00Z', // outside the lead time
      '2026-11-14T15:00:00Z', // due
      '2026-11-13T15:00:00Z', // due, sooner
      undefined, // no slot: never due
    ]);
    const result = await sweepDue(deps(), { leadDays: 3 });
    expect(result.uploaded.map((u) => u.id)).toEqual(['clip-2', 'clip-1']);
    expect(result.uploaded.every((u) => u.outcome === 'uploaded')).toBe(true);
  });

  it("stops at the day's allowance so a quarter cannot go up at once", async () => {
    seedMany(['2026-11-13T09:00:00Z', '2026-11-13T15:00:00Z', '2026-11-14T15:00:00Z']);
    const result = await sweepDue(deps(), { leadDays: 3, dailyUploads: 2 });
    expect(result.uploaded).toHaveLength(2);
    expect(result.deferred).toEqual(['cc/clip-2']);
  });

  it('counts what today already used up', () => {
    const uploaded = (uploadedAt?: string) =>
      ContentItem.parse({
        schemaVersion: 1,
        id: 'x',
        brand: 'cc',
        kind: 'short',
        title: 'x',
        media: { key: 'k' },
        publications: [{ outlet: 'youtube', state: 'published', uploadedAt, warnings: [] }],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    expect(
      uploadsToday(
        [uploaded('2026-11-12T01:00:00Z'), uploaded('2026-11-11T23:00:00Z'), uploaded()],
        'youtube',
        NOW,
      ),
    ).toBe(1);
  });

  it('skips a brand with no channel without touching anything', async () => {
    seedMany(['2026-11-13T15:00:00Z']);
    const feedOnly = BrandConfig.parse({
      schemaVersion: 1,
      slug: 'cc',
      name: 'cc',
      outlets: [{ kind: 'rss', id: 'rss', show: 'cc' }],
    });
    const result = await sweepDue({ ...deps(), brands: async () => [feedOnly] }, {});
    expect(result.uploaded).toEqual([]);
  });
});
