import { layout, parseFeedXml, text, type ShowConfigInput } from '@darkrelay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublisherDeps } from '../src/publisher/feed';
import { rebuildAll, routeObjectCreated } from '../src/publisher/route';
import { MemoryStore } from './memory-store';

const BASE = 'https://media.example.com';
let store: MemoryStore;
let invalidations: string[][];
let pings: string[];
let now: Date;
let deps: PublisherDeps;

const showConfig = (o: Partial<ShowConfigInput> = {}): ShowConfigInput => ({
  schemaVersion: 1,
  slug: 'show',
  status: 'live',
  title: 'Show',
  description: 'About',
  link: 'https://example.com',
  language: 'en',
  author: 'Host',
  owner: { name: 'Host', email: 'host@example.com' },
  image: { key: 'show/cover.jpg' },
  categories: [{ text: 'Technology' }],
  explicit: false,
  podcastGuid: '23f35153-ba05-5a2c-9d23-8c51b427723c',
  podcastIndexNotify: true,
  ...o,
});

const episodeJson = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    show: 'show',
    guid: 'guid-1',
    title: 'Episode 1',
    description: '<p>Notes</p>',
    durationSeconds: 1800,
    ...o,
  });

function upload(bundleId: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    store.seed(`${layout.inboxPrefix('show', bundleId)}${name}`, body);
  }
  return routeObjectCreated(deps, `${layout.inboxPrefix('show', bundleId)}episode.json`);
}

const feedKey = 'public/show/feed.xml';
const feedGuids = () => parseFeedXml(store.text(feedKey)!).items.map((i) => text(i['guid']));

beforeEach(() => {
  store = new MemoryStore();
  invalidations = [];
  pings = [];
  now = new Date('2026-10-11T12:00:00Z');
  deps = {
    store,
    baseUrl: BASE,
    invalidate: async (p) => void invalidations.push(p),
    notifyPodcastIndex: async (u) => void pings.push(u),
    now: () => now,
    log: () => {},
  };
  store.seed(layout.showConfig('show'), JSON.stringify(showConfig()));
});

describe('publishing a bundle', () => {
  it('copies files, writes the manifest and feed, invalidates and pings', async () => {
    const result = await upload('b1', {
      'audio.mp3': 'x'.repeat(100),
      'transcript.vtt': 'WEBVTT',
      'chapters.json': JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0 }] }),
      'episode.json': episodeJson(),
    });
    expect(result).toMatchObject({ status: 'published', guid: 'guid-1', feed: 'written' });

    const id = (result as { episodeId: string }).episodeId;
    const audioKey = `public/show/${id}/b1/audio.mp3`;
    expect(store.objects.get(audioKey)?.opts).toMatchObject({
      contentType: 'audio/mpeg',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    const xml = store.text(feedKey)!;
    expect(xml).toContain(`url="${BASE}/show/${id}/b1/audio.mp3" length="100" type="audio/mpeg"`);
    expect(xml).toContain('<podcast:transcript');
    expect(xml).toContain('<podcast:chapters');
    expect(invalidations).toEqual([['/show/feed.xml']]);
    expect(pings).toEqual([`${BASE}/show/feed.xml`]);
    expect(await store.list('inbox/')).toEqual([]);
    expect(store.json(layout.inboxStatus('show', 'b1'))).toMatchObject({ status: 'published' });
  });

  it('rejects an invalid bundle without touching the feed', async () => {
    const result = await upload('b1', {
      'audio.wav': 'x',
      'episode.json': episodeJson({ title: '' }),
    });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(store.text(feedKey)).toBeUndefined();
    expect(store.json(layout.inboxStatus('show', 'b1'))).toMatchObject({ status: 'rejected' });
  });

  it('rejects bad chapters and a show mismatch', async () => {
    const result = await upload('b1', {
      'audio.mp3': 'x',
      'chapters.json': '{"version":"1","chapters":[]}',
      'episode.json': episodeJson({ show: 'other' }),
    });
    expect(result).toMatchObject({ status: 'rejected' });
    expect((result as { errors: string[] }).errors).toHaveLength(2);
  });

  it('rejects bundles for unknown shows', async () => {
    store.objects.delete(layout.showConfig('show'));
    expect(await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() })).toEqual({
      status: 'rejected',
      errors: ['Show "show" does not exist'],
    });
  });

  it('re-publishing the same guid updates the episode and keeps its pubDate', async () => {
    await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() });
    now = new Date('2026-10-12T12:00:00Z');
    await upload('b2', {
      'audio.mp3': 'xx',
      'episode.json': episodeJson({ title: 'Fixed title' }),
    });

    expect(feedGuids()).toEqual(['guid-1']);
    const xml = store.text(feedKey)!;
    expect(xml).toContain('Fixed title');
    expect(xml).toContain('/b2/audio.mp3');
    expect(xml).toContain('<pubDate>Sun, 11 Oct 2026 12:00:00 GMT</pubDate>');
  });

  it('generates a guid when episode.json has none', async () => {
    const result = await upload('b1', {
      'audio.mp3': 'x',
      'episode.json': episodeJson({ guid: undefined }),
    });
    expect((result as { guid: string }).guid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('feed rebuilds', () => {
  it('builds draft shows to the private preview only', async () => {
    store.seed(layout.showConfig('show'), JSON.stringify(showConfig({ status: 'draft' })));
    await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() });
    expect(store.text(feedKey)).toBeUndefined();
    expect(store.text(layout.previewFeed('show'))).toContain('guid-1');
    expect(invalidations).toEqual([]);
    expect(pings).toEqual([]);
  });

  it('holds future episodes until the hourly sweep after their pubDate', async () => {
    await upload('b1', {
      'audio.mp3': 'x',
      'episode.json': episodeJson({ pubDate: '2026-10-11T15:00:00Z' }),
    });
    expect(feedGuids()).toEqual([]);

    expect(await rebuildAll(deps)).toEqual({ show: 'unchanged' });
    now = new Date('2026-10-11T16:00:00Z');
    expect(await rebuildAll(deps)).toEqual({ show: 'written' });
    expect(feedGuids()).toEqual(['guid-1']);
  });

  it('does not rewrite or invalidate an unchanged feed', async () => {
    await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() });
    invalidations = [];
    expect(await routeObjectCreated(deps, 'requests/show/rebuild')).toMatchObject({
      status: 'unchanged',
    });
    expect(invalidations).toEqual([]);
  });

  it('keeps the last good feed when a rebuild fails validation', async () => {
    await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() });
    const good = store.text(feedKey);
    // Two manifests claiming the same guid produce a duplicate in the feed.
    const manifest = (await store.list(layout.episodesPrefix('show')))[0]!.key;
    store.seed(layout.episodeManifest('show', 'dupe'), store.text(manifest)!);

    const result = await routeObjectCreated(deps, layout.showConfig('show'));
    expect(result).toMatchObject({ status: 'invalid' });
    expect(store.text(feedKey)).toBe(good);
    expect(store.json(layout.feedErrors('show')).errors[0].message).toMatch(/duplicate/);
  });

  it('a failed Podcast Index ping does not fail the publish', async () => {
    deps.notifyPodcastIndex = async () => {
      throw new Error('down');
    };
    const result = await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() });
    expect(result).toMatchObject({ status: 'published', feed: 'written' });
  });

  it('ignores unrelated keys', async () => {
    expect(await routeObjectCreated(deps, 'inbox/show/b1/audio.mp3')).toBeUndefined();
    expect(await routeObjectCreated(deps, 'inbox/../x/episode.json')).toBeUndefined();
  });
});
