import { beforeEach, describe, expect, it } from 'vitest';
import { EpisodeInput, accessFromGroups, episodeId, layout, type Access } from '@darkrelay/core';
import { MAX_FILE_BYTES, partSize, route, type UploadDeps } from '../src/uploads/api';
import { MemoryStore } from './memory-store';

const BUNDLE = '20261017120000-abcdef';
const PREFIX = `inbox/cc/${BUNDLE}/`;
const MiB = 1024 ** 2;
const NOW = new Date('2026-10-17T12:00:00Z');

let store: MemoryStore;
let deps: UploadDeps;
let uploads: Map<string, { key: string; contentType: string }>;

beforeEach(() => {
  store = new MemoryStore();
  store.seed('catalog/cc/show.json', JSON.stringify({ title: 'Chaotic Commits' }));
  store.seed('catalog/dd/show.json', JSON.stringify({ title: 'Dark Dreams' }));
  uploads = new Map();
  deps = {
    store,
    multipart: {
      async create(key, contentType) {
        const id = `up-${uploads.size + 1}`;
        uploads.set(id, { key, contentType });
        return id;
      },
      async signPart(key, uploadId, n) {
        return `https://s3.test/${key}?uploadId=${uploadId}&partNumber=${n}`;
      },
      async complete(key, uploadId, parts) {
        if (uploads.get(uploadId)?.key !== key) throw new Error('NoSuchUpload');
        store.seed(key, 'x'.repeat(parts.length));
      },
    },
    listShows: async () => ['cc', 'dd'],
    newBundleId: () => BUNDLE,
    newGuid: () => 'guid-1',
    now: () => NOW,
  };
});

const uploader = accessFromGroups(['uploader:cc']);
const call = (method: string, path: string, body?: unknown, access: Access = uploader) =>
  route(deps, { method, path, body, access });

const form = {
  title: 'Episode 1',
  description: '<p>Notes</p>',
  durationSeconds: 1234.4,
  pubDate: '2026-10-20T09:00:00-04:00',
  season: 2,
  episode: 7,
};

describe('roles', () => {
  it('403s viewers, users with no role and uploaders of other shows on every route', async () => {
    const paths: [string, string][] = [
      ['POST', '/shows/cc/uploads'],
      ['GET', `/shows/cc/uploads/${BUNDLE}`],
      ['POST', `/shows/cc/uploads/${BUNDLE}/parts`],
      ['POST', `/shows/cc/uploads/${BUNDLE}/files`],
      ['POST', `/shows/cc/uploads/${BUNDLE}/complete`],
    ];
    for (const groups of [[], ['viewer:cc'], ['uploader:dd'], ['uploader']]) {
      for (const [method, path] of paths) {
        expect((await call(method, path, {}, accessFromGroups(groups))).statusCode).toBe(403);
      }
    }
    expect(uploads.size).toBe(0);
  });

  it('lets admins upload to any show', async () => {
    const res = await call(
      'POST',
      '/shows/dd/uploads',
      { files: [{ name: 'audio.mp3', size: 10 }] },
      accessFromGroups(['admin']),
    );
    expect(res.statusCode).toBe(201);
  });

  it('404s a show that does not exist', async () => {
    const res = await call('POST', '/shows/zz/uploads', {}, accessFromGroups(['admin']));
    expect(res.statusCode).toBe(404);
  });

  it('tells the dashboard which shows the user can upload to', async () => {
    expect((await call('GET', '/me')).body).toEqual({
      admin: false,
      view: ['cc'],
      upload: [{ show: 'cc', title: 'Chaotic Commits' }],
    });
    expect((await call('GET', '/me', undefined, accessFromGroups(['viewer:cc']))).body).toEqual({
      admin: false,
      view: ['cc'],
      upload: [],
    });
    expect((await call('GET', '/me', undefined, accessFromGroups(['admin']))).body).toEqual({
      admin: true,
      view: null,
      upload: [
        { show: 'cc', title: 'Chaotic Commits' },
        { show: 'dd', title: 'Dark Dreams' },
      ],
    });
  });
});

describe('create', () => {
  it('starts a multipart upload per file under the bundle prefix', async () => {
    const res = await call('POST', '/shows/cc/uploads', {
      files: [
        { name: 'video.mp4', size: 3 * 1024 ** 3 },
        { name: 'transcript.vtt', size: 2000 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({
      bundleId: BUNDLE,
      files: [
        { name: 'video.mp4', uploadId: 'up-1', partSize: 16 * MiB, partCount: 192 },
        { name: 'transcript.vtt', uploadId: 'up-2', partSize: 16 * MiB, partCount: 1 },
      ],
    });
    expect([...uploads.values()]).toEqual([
      { key: `${PREFIX}video.mp4`, contentType: 'video/mp4' },
      { key: `${PREFIX}transcript.vtt`, contentType: 'text/vtt' },
    ]);
  });

  it('refuses the publisher files, unknown names and bundles without media', async () => {
    for (const files of [
      [{ name: 'episode.json', size: 1 }],
      [{ name: 'processed.json', size: 1 }],
      [
        { name: 'audio.mp3', size: 1 },
        { name: 'episode.json', size: 1 },
      ],
      [{ name: '../escape.mp3', size: 1 }],
      [{ name: 'Audio.MP3', size: 1 }],
      [{ name: 'cover.jpg', size: 1 }],
      [
        { name: 'audio.mp3', size: 1 },
        { name: 'audio.mp3', size: 1 },
      ],
      [{ name: 'audio.mp3', size: MAX_FILE_BYTES + 1 }],
    ]) {
      expect((await call('POST', '/shows/cc/uploads', { files })).statusCode).toBe(400);
    }
    expect(uploads.size).toBe(0);
  });

  it('keeps under 10,000 parts for very large files', () => {
    expect(partSize(10 * MiB)).toBe(16 * MiB);
    expect(Math.ceil(MAX_FILE_BYTES / partSize(MAX_FILE_BYTES))).toBeLessThanOrEqual(10_000);
  });
});

describe('parts and files', () => {
  it('signs part URLs for an allowed file only', async () => {
    const ok = await call('POST', `/shows/cc/uploads/${BUNDLE}/parts`, {
      name: 'audio.mp3',
      uploadId: 'up-1',
      parts: [1, 2],
    });
    expect(ok.body).toEqual({
      urls: {
        1: `https://s3.test/${PREFIX}audio.mp3?uploadId=up-1&partNumber=1`,
        2: `https://s3.test/${PREFIX}audio.mp3?uploadId=up-1&partNumber=2`,
      },
    });
    for (const name of ['episode.json', 'notes.txt']) {
      const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/parts`, {
        name,
        uploadId: 'up-1',
        parts: [1],
      });
      expect(res.statusCode).toBe(400);
    }
    const tooMany = await call('POST', `/shows/cc/uploads/${BUNDLE}/parts`, {
      name: 'audio.mp3',
      uploadId: 'up-1',
      parts: Array.from({ length: 101 }, (_, i) => i + 1),
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('rejects a bad upload id', async () => {
    const res = await call('POST', '/shows/cc/uploads/..%2F..%2Fcatalog/parts', {});
    expect(res.statusCode).toBe(400);
  });

  it('completes a file in part order', async () => {
    await call('POST', '/shows/cc/uploads', { files: [{ name: 'audio.mp3', size: 20 * MiB }] });
    const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/files`, {
      name: 'audio.mp3',
      uploadId: 'up-1',
      parts: [
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a"' },
      ],
    });
    expect(res).toEqual({ statusCode: 200, body: { name: 'audio.mp3', size: 2 } });
  });

  it('stops signing and completing once the upload is submitted', async () => {
    store.seed(`${PREFIX}audio.mp3`, 'a');
    store.seed(`${PREFIX}episode.json`, '{}');
    const sign = await call('POST', `/shows/cc/uploads/${BUNDLE}/parts`, {
      name: 'audio.mp3',
      uploadId: 'up-1',
      parts: [1],
    });
    expect(sign.statusCode).toBe(409);
  });
});

describe('complete', () => {
  it('writes a valid episode.json last, as the CLI does', async () => {
    store.seed(`${PREFIX}audio.mp3`, 'audio');
    store.seed(`${PREFIX}chapters.json`, '{}');
    const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, form);
    expect(res).toEqual({
      statusCode: 202,
      body: { bundleId: BUNDLE, guid: 'guid-1', status: 'queued' },
    });
    const written = store.json(`${PREFIX}episode.json`);
    expect(EpisodeInput.parse(written)).toEqual(written);
    expect(written).toMatchObject({
      schemaVersion: 1,
      show: 'cc',
      guid: 'guid-1',
      title: 'Episode 1',
      pubDate: '2026-10-20T09:00:00-04:00',
      durationSeconds: 1234,
      season: 2,
      episode: 7,
    });
  });

  it('publishes now when no release time is given', async () => {
    store.seed(`${PREFIX}audio.mp3`, 'audio');
    await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, { ...form, pubDate: '' });
    expect(store.json(`${PREFIX}episode.json`).pubDate).toBeUndefined();
  });

  it('refuses a release time without a zone, like --pub-date', async () => {
    store.seed(`${PREFIX}audio.mp3`, 'audio');
    for (const pubDate of ['2026-10-20', '2026-10-20T09:00']) {
      const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, { ...form, pubDate });
      expect(res.statusCode).toBe(400);
    }
    expect(store.text(`${PREFIX}episode.json`)).toBeUndefined();
  });

  it('refuses missing details, missing media and a second submit', async () => {
    expect((await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, form)).statusCode).toBe(404);
    store.seed(`${PREFIX}transcript.vtt`, 'WEBVTT');
    expect((await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, form)).statusCode).toBe(400);
    store.seed(`${PREFIX}audio.mp3`, 'audio');
    const noTitle = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, {
      ...form,
      title: ' ',
    });
    expect(noTitle.statusCode).toBe(400);
    expect((await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, form)).statusCode).toBe(202);
    expect((await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, form)).statusCode).toBe(409);
  });
});

describe('status', () => {
  const get = () => call('GET', `/shows/cc/uploads/${BUNDLE}`);

  it('follows the upload from files to queued to the publisher result', async () => {
    expect((await get()).statusCode).toBe(404);
    store.seed(`${PREFIX}audio.mp3`, 'audio');
    expect((await get()).body).toEqual({ bundleId: BUNDLE, status: 'uploading' });
    store.seed(`${PREFIX}episode.json`, '{}');
    expect((await get()).body).toEqual({ bundleId: BUNDLE, status: 'queued' });
    store.seed(
      `inbox-status/cc/${BUNDLE}.json`,
      JSON.stringify({ status: 'processing', guid: 'g', job: { bucket: 'secret' } }),
    );
    expect((await get()).body).toEqual({ bundleId: BUNDLE, status: 'processing', guid: 'g' });
    store.seed(
      `inbox-status/cc/${BUNDLE}.json`,
      JSON.stringify({ status: 'rejected', errors: ['bad'] }),
    );
    expect((await get()).body).toEqual({ bundleId: BUNDLE, status: 'rejected', errors: ['bad'] });
  });
});

describe('updating an episode', () => {
  const ID = episodeId('old-guid');
  const manifest = (o: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    guid: 'old-guid',
    status: 'published',
    title: 'Old title',
    description: '<p>Old</p>',
    link: 'https://example.com/ep1',
    pubDate: '2026-10-01T09:00:00Z',
    durationSeconds: 1800,
    episodeType: 'full',
    season: 1,
    episode: 3,
    enclosure: { asset: { key: 'cc/x/b/audio.mp3' }, length: 10, type: 'audio/mpeg' },
    transcripts: [{ asset: { key: 'cc/x/b/t.vtt' }, type: 'text/vtt', language: 'fr' }],
    persons: [{ name: 'Guest' }],
    keywords: ['kw'],
    updatedAt: '2026-10-01T09:00:00Z',
    ...o,
  });
  beforeEach(() => {
    store.seed(layout.episodeManifest('cc', ID), JSON.stringify(manifest()));
    store.seed(
      layout.episodeManifest('cc', episodeId('later')),
      JSON.stringify(manifest({ guid: 'later', title: 'Next', pubDate: '2026-10-30T09:00:00Z' })),
    );
  });

  it('lists every episode with its state, newest first, for uploaders only', async () => {
    store.seed(
      layout.episodeManifest('cc', episodeId('gone')),
      JSON.stringify(
        manifest({
          guid: 'gone',
          title: 'Gone',
          status: 'hidden',
          pubDate: '2026-09-01T09:00:00Z',
        }),
      ),
    );
    const res = await call('GET', '/shows/cc/catalog');
    expect(res.statusCode).toBe(200);
    const list = (res.body as { episodes: { title: string; state: string }[] }).episodes;
    expect(list.map((e) => [e.title, e.state])).toEqual([
      ['Next', 'scheduled'],
      ['Old title', 'live'],
      ['Gone', 'hidden'],
    ]);
    expect(
      (await call('GET', '/shows/cc/catalog', undefined, accessFromGroups(['viewer:cc'])))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/shows/cc/catalog/${ID}`, undefined, accessFromGroups(['uploader:dd'])))
        .statusCode,
    ).toBe(403);
  });

  it('returns the details and files of one episode', async () => {
    const res = await call('GET', `/shows/cc/catalog/${ID}`);
    expect(res.body).toMatchObject({
      episodeId: ID,
      title: 'Old title',
      state: 'live',
      season: 1,
      files: { audio: 'audio/mpeg', transcripts: ['text/vtt'], chapters: false, cover: false },
    });
    expect((await call('GET', '/shows/cc/catalog/0000000000000000')).statusCode).toBe(404);
    expect((await call('GET', '/shows/cc/catalog/nope')).statusCode).toBe(400);
  });

  it('updates details with no files, keeping the length and fields the form lacks', async () => {
    const created = await call('POST', '/shows/cc/uploads', { files: [], episodeId: ID });
    expect(created).toEqual({ statusCode: 201, body: { bundleId: BUNDLE, files: [] } });
    const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, {
      episodeId: ID,
      title: 'New title',
      description: '<p>New</p>',
      pubDate: '2026-10-01T09:00:00Z',
      season: 1,
      episodeType: 'bonus',
      status: 'hidden',
    });
    expect(res.statusCode).toBe(202);
    expect(store.json(`${PREFIX}episode.json`)).toEqual(
      EpisodeInput.parse({
        schemaVersion: 1,
        show: 'cc',
        guid: 'old-guid',
        title: 'New title',
        description: '<p>New</p>',
        link: 'https://example.com/ep1',
        pubDate: '2026-10-01T09:00:00Z',
        durationSeconds: 1800,
        season: 1,
        episodeType: 'bonus',
        persons: [{ name: 'Guest' }],
        keywords: ['kw'],
        transcriptLanguage: 'fr',
        status: 'hidden',
      }),
    );
  });

  it('replaces one file without the media, and takes a new length with new media', async () => {
    const created = await call('POST', '/shows/cc/uploads', {
      files: [{ name: 'transcript.srt', size: 5 }],
      episodeId: ID,
    });
    expect(created.statusCode).toBe(201);
    store.seed(`${PREFIX}transcript.srt`, '1');
    store.seed(`${PREFIX}audio.mp3`, 'new');
    const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, {
      episodeId: ID,
      title: 'T',
      description: 'D',
      durationSeconds: 99.6,
    });
    expect(res.statusCode).toBe(202);
    expect(store.json(`${PREFIX}episode.json`).durationSeconds).toBe(100);
  });

  it('still needs media for a new episode, and a real episode for an update', async () => {
    expect((await call('POST', '/shows/cc/uploads', { files: [] })).statusCode).toBe(400);
    const missing = await call('POST', '/shows/cc/uploads', {
      files: [],
      episodeId: '0000000000000000',
    });
    expect(missing.statusCode).toBe(404);
    const complete = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, {
      title: 'T',
      description: 'D',
      durationSeconds: 10,
    });
    expect(complete.statusCode).toBe(404);
  });

  it('asks before moving a released episode into the future, but not a scheduled one', async () => {
    const body = { episodeId: ID, title: 'T', description: 'D', pubDate: '2026-11-01T09:00:00Z' };
    const res = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, body);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/already out/);
    expect(store.text(`${PREFIX}episode.json`)).toBeUndefined();
    const forced = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, {
      ...body,
      force: true,
    });
    expect(forced.statusCode).toBe(202);

    store.delete([`${PREFIX}episode.json`]);
    const later = await call('POST', `/shows/cc/uploads/${BUNDLE}/complete`, {
      ...body,
      episodeId: episodeId('later'),
      pubDate: '2026-11-02T09:00:00Z',
    });
    expect(later.statusCode).toBe(202);
  });
});
