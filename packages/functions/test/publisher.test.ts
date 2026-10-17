import {
  layout,
  parseFeedXml,
  text,
  type ShowConfigInput,
  type TranscodeJob,
} from '@darkrelay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublisherDeps } from '../src/publisher/feed';
import { rebuildFeed } from '../src/publisher/feed';
import { onTranscoderStopped, rebuildAll, routeObjectCreated } from '../src/publisher/route';
import { MemoryStore } from './memory-store';

const BASE = 'https://media.example.com';
let store: MemoryStore;
let invalidations: string[][];
let pings: string[];
let schedules: Map<string, string | undefined>;
let transcodes: { job: TranscodeJob; spot?: boolean }[];
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
  schedules = new Map();
  transcodes = [];
  now = new Date('2026-10-11T12:00:00Z');
  deps = {
    store,
    bucketName: 'media',
    startTranscode: async (job, opts) => void transcodes.push({ job, spot: opts?.spot }),
    baseUrl: BASE,
    invalidate: async (p) => void invalidations.push(p),
    notifyPodcastIndex: async (u) => void pings.push(u),
    scheduleRelease: async (show, at) => void schedules.set(show, at?.toISOString()),
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

  it('updates an existing episode from a bundle without media, keeping its files', async () => {
    await upload('b1', {
      'audio.mp3': 'x',
      'transcript.vtt': 'WEBVTT',
      'chapters.json': JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0 }] }),
      'cover.jpg': 'img',
      'episode.json': episodeJson(),
    });
    const key = (await store.list(layout.episodesPrefix('show')))[0]!.key;
    const before = store.json(key);

    const result = await upload('b2', { 'episode.json': episodeJson({ title: 'Renamed' }) });
    expect(result).toMatchObject({ status: 'published', guid: 'guid-1' });
    const after = store.json(key);
    expect(after.title).toBe('Renamed');
    for (const field of ['enclosure', 'transcripts', 'chapters', 'image'])
      expect(after[field]).toEqual(before[field]);
    expect(store.text(feedKey)).toContain('Renamed');
  });

  it('replaces only the files a bundle carries', async () => {
    await upload('b1', {
      'audio.mp3': 'x',
      'transcript.vtt': 'WEBVTT',
      'episode.json': episodeJson(),
    });
    await upload('b2', { 'transcript.srt': '1', 'episode.json': episodeJson() });
    const key = (await store.list(layout.episodesPrefix('show')))[0]!.key;
    const m = store.json(key);
    expect(m.enclosure.asset.key).toContain('/b1/audio.mp3');
    expect(m.transcripts).toEqual([
      expect.objectContaining({ asset: { key: expect.stringContaining('/b2/transcript.srt') } }),
    ]);
  });

  it('still needs media for a new episode', async () => {
    const result = await upload('b1', { 'episode.json': episodeJson({ guid: 'brand-new' }) });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(await store.list(layout.episodesPrefix('show'))).toEqual([]);
  });

  it('hides and restores an episode from episode.json', async () => {
    await upload('b1', { 'audio.mp3': 'x', 'episode.json': episodeJson() });
    await upload('b2', { 'episode.json': episodeJson({ status: 'hidden' }) });
    expect(feedGuids()).toEqual([]);
    await upload('b3', { 'episode.json': episodeJson() });
    expect(feedGuids()).toEqual([]);
    await upload('b4', { 'episode.json': episodeJson({ status: 'published' }) });
    expect(feedGuids()).toEqual(['guid-1']);
  });

  it('re-publishing keeps the YouTube link and copy; an empty youtube object clears the copy', async () => {
    await upload('b1', {
      'audio.mp3': 'x',
      'episode.json': episodeJson({ youtube: { title: 'Search Title' } }),
    });
    const key = (await store.list(layout.episodesPrefix('show')))[0]!.key;
    expect(store.json(key).youtubeCopy).toEqual({ title: 'Search Title' });

    // The YouTube uploader links the video it made.
    const link = { videoId: 'vid1', linkedAt: '2026-10-11T12:00:00Z', metadataHash: 'h' };
    store.seed(key, JSON.stringify({ ...store.json(key), youtube: link }));

    await upload('b2', { 'audio.mp3': 'xx', 'episode.json': episodeJson({ title: 'Fixed' }) });
    expect(store.json(key)).toMatchObject({
      youtube: link,
      youtubeCopy: { title: 'Search Title' },
    });

    await upload('b3', { 'audio.mp3': 'x', 'episode.json': episodeJson({ youtube: {} }) });
    expect(store.json(key).youtubeCopy).toBeUndefined();
    expect(store.json(key).youtube).toEqual(link);
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

describe('scheduled releases', () => {
  const future = (guid: string, pubDate: string) =>
    upload(guid, { 'audio.mp3': 'x', 'episode.json': episodeJson({ guid, pubDate }) });

  it('holds a future episode and schedules a rebuild just after its release time', async () => {
    const result = await future('later', '2026-10-20T09:00:00Z');
    expect(result).toMatchObject({ status: 'published', scheduledFor: '2026-10-20T09:00:00Z' });
    expect(feedGuids()).toEqual([]);
    expect(schedules.get('show')).toBe('2026-10-20T09:00:05.000Z');
  });

  it('schedules the earliest of several, and moves on to the next after each release', async () => {
    await future('second', '2026-10-21T09:00:00Z');
    await future('first', '2026-10-20T09:00:00Z');
    expect(schedules.get('show')).toBe('2026-10-20T09:00:05.000Z');

    now = new Date('2026-10-20T09:00:05Z'); // the schedule fires
    expect(await rebuildFeed(deps, 'show')).toMatchObject({ status: 'written' });
    expect(feedGuids()).toEqual(['first']);
    expect(schedules.get('show')).toBe('2026-10-21T09:00:05.000Z');
    expect(invalidations.at(-1)).toEqual(['/show/feed.xml']);
    expect(pings.length).toBeGreaterThan(0);

    now = new Date('2026-10-21T09:00:05Z');
    await rebuildFeed(deps, 'show');
    expect(feedGuids()).toEqual(['second', 'first']);
    expect(schedules.get('show')).toBeUndefined();
  });

  it('does not publish or schedule early: a past-due episode appears, the future one waits', async () => {
    await future('past', '2026-10-01T00:00:00Z');
    await future('next', '2026-10-30T00:00:00Z');
    expect(feedGuids()).toEqual(['past']);
    expect(schedules.get('show')).toBe('2026-10-30T00:00:05.000Z');
  });

  it('ignores hidden episodes and draft shows', async () => {
    await future('later', '2026-10-20T09:00:00Z');
    const manifest = (await store.list(layout.episodesPrefix('show')))[0]!.key;
    store.seed(manifest, JSON.stringify({ ...store.json(manifest), status: 'hidden' }));
    await rebuildFeed(deps, 'show');
    expect(schedules.get('show')).toBeUndefined();

    store.seed(layout.showConfig('show'), JSON.stringify(showConfig({ status: 'draft' })));
    await future('draft-later', '2026-10-20T09:00:00Z');
    expect(schedules.get('show')).toBeUndefined();
  });

  it('a scheduler failure does not fail the publish; the hourly sweep still releases', async () => {
    deps.scheduleRelease = async () => {
      throw new Error('throttled');
    };
    expect(await future('later', '2026-10-20T09:00:00Z')).toMatchObject({ status: 'published' });
    now = new Date('2026-10-20T10:00:00Z');
    expect(await rebuildAll(deps)).toEqual({ show: 'written' });
    expect(feedGuids()).toEqual(['later']);
  });
});

describe('video', () => {
  const videoShow = () =>
    store.seed(
      layout.showConfig('show'),
      JSON.stringify(showConfig({ video: { hls: true, ladder: [1080, 720] } })),
    );

  /** What the Fargate task does: audio and HLS into place, then processed.json. */
  function finishTranscode(job: TranscodeJob, ok = true) {
    if (ok) {
      store.seed(job.bundlePrefix + 'audio.mp3', 'x'.repeat(50));
      store.seed(job.hls!.prefix + 'master.m3u8', '#EXTM3U');
    }
    store.seed(
      job.bundlePrefix + 'processed.json',
      JSON.stringify(
        ok
          ? {
              ok: true,
              audio: 'audio.mp3',
              hls: {
                masterKey: job.hls!.prefix + 'master.m3u8',
                renditions: [
                  { height: 1080, width: 1920, bandwidth: 5_600_000 },
                  { height: 720, width: 1280, bandwidth: 2_500_000 },
                ],
              },
              durationSeconds: 1800,
              finishedAt: '2026-10-11T12:10:00Z',
            }
          : {
              ok: false,
              error: 'No video stream in the uploaded file',
              finishedAt: '2026-10-11T12:10:00Z',
            },
      ),
    );
    return routeObjectCreated(deps, job.bundlePrefix + 'processed.json');
  }

  it('video-only upload: transcode first, then publish with extracted audio and HLS', async () => {
    videoShow();
    const first = await upload('b1', {
      'video.mp4': 'v'.repeat(200),
      'episode.json': episodeJson(),
    });
    expect(first).toMatchObject({ status: 'processing', guid: 'guid-1' });
    expect(store.text(feedKey)).toBeUndefined();
    expect(store.json(layout.inboxStatus('show', 'b1'))).toMatchObject({ status: 'processing' });

    const { job, spot } = transcodes[0]!;
    expect(spot).toBeUndefined(); // Spot by default
    expect(job).toMatchObject({
      bucket: 'media',
      bundlePrefix: 'inbox/show/b1/',
      video: 'video.mp4',
      extractAudio: true,
      hls: { ladder: [1080, 720] },
    });
    expect(job.hls!.prefix).toMatch(/^public\/show\/[0-9a-f]{16}\/b1\/hls\/$/);

    const second = await finishTranscode(job);
    expect(second).toMatchObject({ status: 'published', feed: 'written' });
    const xml = store.text(feedKey)!;
    expect(xml).toMatch(/<enclosure url="[^"]+\/b1\/audio\.mp3" length="50" type="audio\/mpeg"\/>/);
    expect(xml).toContain(
      '<podcast:alternateEnclosure type="application/x-mpegURL" title="Video" height="1080" bitrate="5600000">',
    );
    expect(xml).toMatch(
      /<podcast:source uri="https:\/\/media\.example\.com\/show\/[0-9a-f]{16}\/b1\/hls\/master\.m3u8"\/>/,
    );
    expect(await store.list('inbox/')).toEqual([]);
  });

  it('audiogram show: audio + video publish immediately, video kept, nothing streamed', async () => {
    const result = await upload('b1', {
      'audio.mp3': 'x',
      'video.mp4': 'v',
      'episode.json': episodeJson(),
    });
    expect(result).toMatchObject({ status: 'published' });
    expect(transcodes).toEqual([]);
    const manifest = store.json((await store.list(layout.episodesPrefix('show')))[0]!.key);
    expect(manifest.video.key).toMatch(/\/b1\/video\.mp4$/);
    expect(manifest.alternateEnclosures).toEqual([]);
    expect(store.text(feedKey)).not.toContain('alternateEnclosure');
  });

  it('audiogram show with only a video: extracts audio but builds no HLS', async () => {
    await upload('b1', { 'video.mp4': 'v', 'episode.json': episodeJson() });
    expect(transcodes[0]!.job).toMatchObject({ extractAudio: true, hls: undefined });
  });

  it('a guid-less video bundle keeps the same guid across both passes', async () => {
    videoShow();
    const first = (await upload('b1', {
      'video.mp4': 'v',
      'episode.json': episodeJson({ guid: undefined }),
    })) as {
      guid: string;
    };
    const second = (await finishTranscode(transcodes[0]!.job)) as { guid: string };
    expect(second.guid).toBe(first.guid);
  });

  it('rejects the bundle when transcoding fails', async () => {
    videoShow();
    await upload('b1', { 'video.mp4': 'v', 'episode.json': episodeJson() });
    expect(await finishTranscode(transcodes[0]!.job, false)).toEqual({
      status: 'rejected',
      errors: ['Video processing failed: No video stream in the uploaded file'],
    });
    expect(store.text(feedKey)).toBeUndefined();
  });

  describe('when the task stops', () => {
    const stopped = (job: TranscodeJob, reason = 'Your Spot Task was interrupted.') => ({
      stoppedReason: reason,
      overrides: {
        containerOverrides: [{ environment: [{ name: 'JOB', value: JSON.stringify(job) }] }],
      },
    });

    it('retries a Spot interruption once on regular Fargate, then fails the bundle', async () => {
      videoShow();
      await upload('b1', { 'video.mp4': 'v', 'episode.json': episodeJson() });
      const job = transcodes[0]!.job;

      expect(await onTranscoderStopped(deps, stopped(job))).toBe('retried');
      expect(transcodes[1]).toMatchObject({ spot: false, job: { attempt: 2 } });

      expect(
        await onTranscoderStopped(deps, stopped(transcodes[1]!.job, 'Essential container exited')),
      ).toBe('failed');
      const result = await routeObjectCreated(deps, job.bundlePrefix + 'processed.json');
      expect(result).toMatchObject({ status: 'rejected' });
      expect((result as { errors: string[] }).errors[0]).toMatch(
        /stopped twice.*Essential container exited/,
      );
    });

    it('does nothing when the task finished normally', async () => {
      videoShow();
      await upload('b1', { 'video.mp4': 'v', 'episode.json': episodeJson() });
      const job = transcodes[0]!.job;
      await finishTranscode(job);
      // The bundle is published and cleaned up by now; processed.json is gone too,
      // so check against a fresh in-flight bundle instead.
      store.seed(job.bundlePrefix + 'processed.json', '{}');
      expect(await onTranscoderStopped(deps, stopped(job))).toBe('finished');
      expect(transcodes).toHaveLength(1);
    });

    it('ignores tasks that are not transcoder jobs', async () => {
      expect(await onTranscoderStopped(deps, {})).toBeUndefined();
    });
  });
});
