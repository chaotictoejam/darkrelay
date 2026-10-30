import {
  EpisodeManifest,
  layout,
  type ShowConfigInput,
  YouTube,
  refreshAccessToken,
} from '@darkrelay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  onEpisodeChanged,
  type UploadDeps,
  type UploadEvent,
} from '../src/youtube/upload';
import { FakeYouTube } from './fake-youtube';
import { MemoryStore } from './memory-store';

const ID = '0123456789abcdef';
let fake: FakeYouTube;
let store: MemoryStore;
let now: Date;
let handoffs: UploadEvent[];
let budget: number[];
let deps: UploadDeps;

beforeAll(async () => {
  fake = await new FakeYouTube().start();
});
afterAll(() => fake.stop());

const show = (yt: Partial<NonNullable<ShowConfigInput['youtube']>> = {}): ShowConfigInput => ({
  schemaVersion: 1,
  slug: 'hcu',
  status: 'live',
  title: 'Her Career Unplugged',
  description: 'd',
  link: 'https://example.com',
  language: 'en',
  author: 'a',
  owner: { name: 'a', email: 'a@example.com' },
  image: { key: 'hcu/cover.jpg' },
  categories: [{ text: 'Business' }],
  explicit: false,
  podcastGuid: '23f35153-ba05-5a2c-9d23-8c51b427723c',
  youtube: { connection: 'hcu', categoryId: '27', tags: ['careers'], ...yt },
});

function seed(
  opts: {
    size?: number;
    pubDate?: string;
    manifest?: Record<string, unknown>;
    showYt?: Parameters<typeof show>[0];
  } = {},
) {
  store.seed(layout.showConfig('hcu'), JSON.stringify(show(opts.showYt)));
  store.seed(
    'public/hcu/' + ID + '/b1/video.mp4',
    new Uint8Array(opts.size ?? 1000).map((_, i) => i % 251),
  );
  store.seed('public/hcu/' + ID + '/b1/cover.jpg', 'jpg');
  store.seed('public/hcu/' + ID + '/b1/transcript.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi');
  store.seed(
    'public/hcu/' + ID + '/b1/chapters.json',
    JSON.stringify({
      version: '1.2.0',
      chapters: [
        { startTime: 0, title: 'Intro' },
        { startTime: 60, title: 'Story' },
        { startTime: 600, title: 'Advice' },
      ],
    }),
  );
  store.seed(
    layout.episodeManifest('hcu', ID),
    JSON.stringify(
      EpisodeManifest.parse({
        schemaVersion: 1,
        guid: 'g1',
        title: 'From Scared to Published <live>',
        description: '<p>Notes with <a href="https://ex.com">a link</a> &amp; more.</p>',
        pubDate: opts.pubDate ?? '2026-10-12T10:00:00Z',
        durationSeconds: 2400,
        enclosure: { asset: { key: `hcu/${ID}/b1/audio.mp3` }, length: 1, type: 'audio/mpeg' },
        image: { key: `hcu/${ID}/b1/cover.jpg` },
        transcripts: [
          { asset: { key: `hcu/${ID}/b1/transcript.vtt` }, type: 'text/vtt', language: 'en' },
        ],
        chapters: { key: `hcu/${ID}/b1/chapters.json` },
        keywords: ['leadership'],
        video: { key: `hcu/${ID}/b1/video.mp4` },
        updatedAt: '2026-10-12T10:00:00Z',
        ...opts.manifest,
      }),
    ),
  );
}

const manifest = () => EpisodeManifest.parse(store.json(layout.episodeManifest('hcu', ID)));
const state = () => store.json(layout.youtubeUpload('hcu', ID));

beforeEach(() => {
  store = new MemoryStore();
  now = new Date('2026-10-12T12:00:00Z');
  handoffs = [];
  budget = [];
  fake.sessions.clear();
  fake.videos.clear();
  fake.thumbnails = [];
  fake.thumbnailBodies = [];
  fake.failThumbnail = undefined;
  fake.captions = [];
  fake.playlist = [];
  fake.statusUpdates = [];
  fake.snippetUpdates = [];
  fake.failSnippet = undefined;
  fake.failNextChunks = 0;
  fake.forcePrivate = false;
  deps = {
    store,
    youtubeFor: async () =>
      new YouTube(
        await refreshAccessToken({ clientId: 'c', clientSecret: 's' }, 'r', fake.endpoints),
        fake.endpoints,
      ),
    continueLater: async (e) => void handoffs.push(e),
    // Each call consumes one entry; when empty, plenty of time is left.
    timeLeftMs: () => budget.shift() ?? 600_000,
    now: () => now,
    log: () => {},
  };
});

describe('YouTube upload', () => {
  it('uploads the video byte-for-byte with clean metadata, then adds captions, thumbnail and playlist', async () => {
    seed({ showYt: { playlistId: 'PL1' } });
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('uploaded');

    const [videoId, video] = [...fake.videos.entries()][0]!;
    expect(video.bytes).toEqual(
      Buffer.from(store.objects.get(`public/hcu/${ID}/b1/video.mp4`)!.body),
    );
    expect(video.metadata.snippet).toMatchObject({
      title: 'From Scared to Published ‹live›',
      categoryId: '27',
      tags: ['careers', 'leadership'],
      defaultLanguage: 'en',
    });
    expect(video.metadata.snippet['description']).toBe(
      'Notes with a link (https://ex.com) & more.\n\nChapters\n0:00 Intro\n1:00 Story\n10:00 Advice',
    );
    expect(video.metadata.status).toEqual({
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
    });

    expect(fake.thumbnails).toEqual([videoId]);
    expect(fake.thumbnailBodies).toEqual(['jpg']);
    expect(manifest().youtube?.thumbnailKey).toBe(`hcu/${ID}/b1/cover.jpg`);
    expect(fake.captions[0]).toMatchObject({ videoId });
    expect(fake.captions[0]!.body).toContain('WEBVTT');
    expect(fake.playlist).toEqual([{ playlistId: 'PL1', videoId }]);
    expect(manifest().youtube).toMatchObject({ videoId });
    expect(state()).toMatchObject({ state: 'done', videoId, warnings: [] });
  });

  it('runs once: later manifest writes, including its own, do nothing', async () => {
    seed();
    await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID });
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('already');
    expect(fake.videos.size).toBe(1);
  });

  it('a second event while one is uploading does not start a duplicate', async () => {
    seed({ size: CHUNK_BYTES + 10 });
    budget = [600_000, 10_000]; // one chunk, then hand off
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('continuing');
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('in-progress');
    expect(fake.sessions.size).toBe(1);
  });

  it('hands off between invocations near the time limit and resumes where it stopped', async () => {
    seed({ size: CHUNK_BYTES * 2 + 123 });
    budget = [600_000, 10_000];
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('continuing');
    expect(handoffs).toEqual([{ show: 'hcu', episodeId: ID, continuation: true }]);
    expect(state()).toMatchObject({ state: 'uploading', offset: CHUNK_BYTES });

    expect(await onEpisodeChanged(deps, handoffs[0]!)).toBe('uploaded');
    const video = [...fake.videos.values()][0]!;
    expect(video.bytes.length).toBe(CHUNK_BYTES * 2 + 123);
    expect(fake.sessions.size).toBe(1);
  }, 60_000);

  it('recovers from a failed chunk by asking the session for its offset', async () => {
    seed({ size: 5000 });
    fake.failNextChunks = 1;
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('uploaded');
    expect([...fake.videos.values()][0]!.bytes.length).toBe(5000);
  });

  it('schedules a future episode as private with publishAt, and moves it when rescheduled', async () => {
    seed({ pubDate: '2026-10-20T10:00:00Z' });
    await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID });
    expect([...fake.videos.values()][0]!.metadata.status).toEqual({
      privacyStatus: 'private',
      publishAt: '2026-10-20T10:00:00.000Z',
      selfDeclaredMadeForKids: false,
    });
    expect(manifest().youtube?.publishAt).toBe('2026-10-20T10:00:00.000Z');

    store.seed(
      layout.episodeManifest('hcu', ID),
      JSON.stringify({ ...manifest(), pubDate: '2026-10-22T10:00:00Z' }),
    );
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('synced');
    expect(fake.statusUpdates.at(-1)).toMatchObject({
      status: { privacyStatus: 'private', publishAt: '2026-10-22T10:00:00.000Z' },
    });
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('already');
  });

  it('warns when YouTube forces the upload private (unaudited API project)', async () => {
    seed();
    fake.forcePrivate = true;
    await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID });
    expect(state().warnings[0]).toMatch(/audit/);
  });

  it('skips shows without YouTube, manual-upload shows, hidden and video-less episodes', async () => {
    seed({ showYt: { upload: false } });
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('manual');
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID, force: true })).toBe(
      'uploaded',
    );

    seed({ manifest: { video: undefined } });
    store.objects.delete(layout.youtubeUpload('hcu', ID));
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('no-video');

    seed({ manifest: { status: 'hidden' } });
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('hidden');

    const { youtube: _y, ...noYt } = show();
    store.seed(layout.showConfig('hcu'), JSON.stringify(noYt));
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('no-youtube');
  });

  it('records a failure and retries on the next change', async () => {
    seed();
    store.objects.delete(`public/hcu/${ID}/b1/video.mp4`);
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('failed');
    expect(state()).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/Video file missing/),
    });

    seed();
    expect(await onEpisodeChanged(deps, { show: 'hcu', episodeId: ID })).toBe('uploaded');
  });
});

describe('YouTube metadata', () => {
  const ev = { show: 'hcu', episodeId: ID };
  const rewrite = (patch: Record<string, unknown>) =>
    store.seed(layout.episodeManifest('hcu', ID), JSON.stringify({ ...manifest(), ...patch }));

  it("uploads with the episode's own YouTube copy and records what it sent", async () => {
    seed({ manifest: { youtubeCopy: { title: 'Search Title', description: 'For YouTube.' } } });
    expect(await onEpisodeChanged(deps, ev)).toBe('uploaded');
    const video = [...fake.videos.values()][0]!;
    expect(video.metadata.snippet['title']).toBe('Search Title');
    expect(video.metadata.snippet['description']).toBe(
      'For YouTube.\n\nChapters\n0:00 Intro\n1:00 Story\n10:00 Advice',
    );
    expect(manifest().youtube?.metadataHash).toMatch(/^[0-9a-f]{16}$/);
    expect(state().metadataHash).toBe(manifest().youtube?.metadataHash);
  });

  it('a republish with changed copy updates the video once; unchanged writes cost nothing', async () => {
    seed();
    await onEpisodeChanged(deps, ev);
    const videoId = manifest().youtube!.videoId;

    rewrite({ updatedAt: '2026-10-13T00:00:00Z' }); // republished, same metadata
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
    expect(fake.snippetUpdates).toEqual([]);

    rewrite({ youtubeCopy: { title: 'Better Title' } });
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
    expect(fake.snippetUpdates).toHaveLength(1);
    expect(fake.snippetUpdates[0]).toMatchObject({
      id: videoId,
      snippet: { title: 'Better Title', categoryId: '27', tags: ['careers', 'leadership'] },
    });
    // Its own manifest write comes back as an event: nothing more to do.
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
    expect(fake.snippetUpdates).toHaveLength(1);
  });

  it('moves the schedule and updates the copy in one pass', async () => {
    seed({ pubDate: '2026-10-20T10:00:00Z' });
    await onEpisodeChanged(deps, ev);
    rewrite({ pubDate: '2026-10-22T10:00:00Z', youtubeCopy: { title: 'New' } });
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
    expect(fake.statusUpdates).toHaveLength(1);
    expect(fake.snippetUpdates).toHaveLength(1);
    expect(manifest().youtube?.publishAt).toBe('2026-10-22T10:00:00.000Z');
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
  });

  it('leaves linked videos alone unless asked to push', async () => {
    seed({
      manifest: {
        youtube: { videoId: 'linked00001', linkedAt: '2026-10-01T00:00:00Z' },
        youtubeCopy: { title: 'Mine' },
      },
    });
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
    expect(fake.snippetUpdates).toEqual([]);
    expect(fake.videos.size).toBe(0);

    expect(await onEpisodeChanged(deps, { ...ev, pushMetadata: true })).toBe('synced');
    expect(fake.snippetUpdates[0]).toMatchObject({ id: 'linked00001', snippet: { title: 'Mine' } });
  });

  it('adopts the current copy of a video uploaded before hashes were kept, unless the episode has its own', async () => {
    const legacy = {
      youtube: { videoId: 'vidOld', linkedAt: '2026-10-01T00:00:00Z' },
    };
    seed({ manifest: legacy });
    store.seed(
      layout.youtubeUpload('hcu', ID),
      JSON.stringify({
        state: 'done',
        videoId: 'vidOld',
        offset: 0,
        warnings: [],
        startedAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      }),
    );
    // A reschedule or republish must not overwrite edits made in YouTube Studio.
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
    expect(fake.snippetUpdates).toEqual([]);
    expect(manifest().youtube?.metadataHash).toMatch(/^[0-9a-f]{16}$/);

    rewrite({ youtube: legacy.youtube, youtubeCopy: { title: 'Search Title' } });
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
    expect(fake.snippetUpdates[0]).toMatchObject({
      id: 'vidOld',
      snippet: { title: 'Search Title' },
    });
  });

  it('records a failed update as a warning and retries on the next change', async () => {
    seed();
    await onEpisodeChanged(deps, ev);
    rewrite({ youtubeCopy: { title: 'New' } });
    fake.failSnippet = 403;
    await expect(onEpisodeChanged(deps, ev)).rejects.toThrow();
    expect(state().warnings.at(-1)).toMatch(/Updating title and description/);

    fake.failSnippet = undefined;
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
  });
});

describe('YouTube thumbnail', () => {
  const ev = { show: 'hcu', episodeId: ID };
  const rewrite = (patch: Record<string, unknown>) =>
    store.seed(layout.episodeManifest('hcu', ID), JSON.stringify({ ...manifest(), ...patch }));
  const thumbnail = (bundle: string, body: string) => {
    store.seed(`public/hcu/${ID}/${bundle}/thumbnail.png`, body);
    return { key: `hcu/${ID}/${bundle}/thumbnail.png` };
  };

  it('uses the 16:9 thumbnail over the square artwork', async () => {
    seed({ manifest: { thumbnail: thumbnail('b1', 'wide') } });
    expect(await onEpisodeChanged(deps, ev)).toBe('uploaded');
    expect(fake.thumbnailBodies).toEqual(['wide']);
    expect(manifest().youtube?.thumbnailKey).toBe(`hcu/${ID}/b1/thumbnail.png`);
  });

  it('sends a new thumbnail to an uploaded video once', async () => {
    seed();
    await onEpisodeChanged(deps, ev);
    rewrite({ thumbnail: thumbnail('b2', 'wide') });
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
    expect(fake.thumbnailBodies).toEqual(['jpg', 'wide']);
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
    expect(fake.thumbnails).toHaveLength(2);
  });

  it('assumes videos uploaded before thumbnailKey was kept have the artwork', async () => {
    const legacy = { youtube: { videoId: 'vidOld', linkedAt: '2026-10-01T00:00:00Z' } };
    seed({ manifest: legacy });
    store.seed(
      layout.youtubeUpload('hcu', ID),
      JSON.stringify({
        state: 'done',
        videoId: 'vidOld',
        offset: 0,
        warnings: [],
        startedAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      }),
    );
    await onEpisodeChanged(deps, ev);
    expect(fake.thumbnails).toEqual([]);

    rewrite({ youtube: manifest().youtube, thumbnail: thumbnail('b2', 'wide') });
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
    expect(fake.thumbnails).toEqual(['vidOld']);
  });

  it('leaves linked videos alone', async () => {
    seed({
      manifest: {
        youtube: { videoId: 'linked00001', linkedAt: '2026-10-01T00:00:00Z' },
        thumbnail: thumbnail('b1', 'wide'),
      },
    });
    expect(await onEpisodeChanged(deps, { ...ev, pushMetadata: true })).toBe('synced');
    expect(fake.thumbnails).toEqual([]);
  });

  it('warns once when the thumbnail fails, and tries again on the next change', async () => {
    seed();
    await onEpisodeChanged(deps, ev);
    fake.failThumbnail = 403;
    rewrite({ thumbnail: thumbnail('b2', 'wide') });
    expect(await onEpisodeChanged(deps, ev)).toBe('already');
    rewrite({ updatedAt: '2026-10-13T00:00:00Z' });
    await onEpisodeChanged(deps, ev);
    expect(state().warnings.filter((w: string) => w.startsWith('Thumbnail'))).toHaveLength(1);

    fake.failThumbnail = undefined;
    rewrite({ updatedAt: '2026-10-14T00:00:00Z' });
    expect(await onEpisodeChanged(deps, ev)).toBe('synced');
    expect(fake.thumbnailBodies).toEqual(['jpg', 'wide']);
  });
});
