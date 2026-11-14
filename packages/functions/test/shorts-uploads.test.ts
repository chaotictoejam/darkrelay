import { BrandConfig, SHORTS_MANIFEST_FILE, accessFromGroups, layout } from '@darkrelay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadBrand } from '../src/lib/brands';
import { route, type UploadDeps } from '../src/uploads/api';
import { MAX_BATCH_FILES } from '../src/uploads/shorts-api';
import { MemoryStore } from './memory-store';

/**
 * The dashboard's Shorts batch upload. The contract worth holding onto: the
 * manifest is written last and only once, nothing is written for a batch
 * whose files are not all there, and a brand with no feed can still upload —
 * a Short goes to a channel, not to an RSS feed.
 */

const BATCH = '20261113120000-abcdef';
const PREFIX = `inbox/cc/${BATCH}/`;
const NOW = new Date('2026-11-13T12:00:00Z');

let store: MemoryStore;
let deps: UploadDeps;
let uploads: Map<string, { key: string; contentType: string }>;

const brand = (over: Record<string, unknown> = {}) =>
  BrandConfig.parse({
    schemaVersion: 1,
    slug: 'cc',
    name: 'Chaotic Commits',
    outlets: [
      { kind: 'rss', id: 'rss', show: 'cc' },
      { kind: 'youtube', id: 'youtube', connection: 'cc', channelTitle: 'Chaotic Commits' },
    ],
    ...over,
  });

beforeEach(() => {
  store = new MemoryStore();
  store.seed('catalog/cc/show.json', JSON.stringify({ title: 'Chaotic Commits' }));
  store.seed('catalog/cc/brand.json', JSON.stringify(brand()));
  // A brand with a channel and no feed at all: the case the CLI serves and
  // the episode upload cannot.
  store.seed(
    'catalog/dr/brand.json',
    JSON.stringify(
      BrandConfig.parse({
        schemaVersion: 1,
        slug: 'dr',
        name: 'Dr. Joanne Skiles',
        outlets: [{ kind: 'youtube', id: 'main', connection: 'dr' }],
      }),
    ),
  );
  // A brand with a feed and no channel at all.
  store.seed(
    'catalog/pod/brand.json',
    JSON.stringify(
      BrandConfig.parse({
        schemaVersion: 1,
        slug: 'pod',
        name: 'Just A Podcast',
        outlets: [{ kind: 'rss', id: 'rss', show: 'pod' }],
      }),
    ),
  );
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
    listCatalog: async () => ['cc', 'dr', 'pod'],
    loadBrand: (slug) => loadBrand(store, slug),
    newBundleId: () => BATCH,
    newGuid: () => 'guid-1',
    now: () => NOW,
  };
});

const uploader = accessFromGroups(['uploader:cc']);
const call = (method: string, path: string, body?: unknown, access = uploader) =>
  route(deps, { method, path, body, access });

const clip = (over: Record<string, unknown> = {}) => ({
  file: 'clip-01.mp4',
  title: 'The bus factor nobody admits to',
  ...over,
});

/** Opens a batch and puts its files in the inbox, as the browser would. */
async function uploaded(names = ['clip-01.mp4']) {
  const res = await call(
    'POST',
    '/brands/cc/shorts',
    { files: names.map((name) => ({ name, size: 1024 })) },
    uploader,
  );
  expect(res.statusCode).toBe(201);
  for (const name of names) store.seed(PREFIX + name, 'bytes');
  return res.body as { batchId: string; files: { name: string; uploadId: string }[] };
}

describe('roles', () => {
  it('403s viewers, the role-less and uploaders of other brands on every route', async () => {
    const paths: [string, string][] = [
      ['GET', '/brands/cc/shorts'],
      ['POST', '/brands/cc/shorts'],
      ['GET', `/brands/cc/shorts/${BATCH}`],
      ['POST', `/brands/cc/shorts/${BATCH}/parts`],
      ['POST', `/brands/cc/shorts/${BATCH}/files`],
      ['POST', `/brands/cc/shorts/${BATCH}/complete`],
    ];
    for (const groups of [[], ['viewer:cc'], ['uploader:dr'], ['uploader']]) {
      for (const [method, path] of paths) {
        expect((await call(method, path, {}, accessFromGroups(groups))).statusCode).toBe(403);
      }
    }
    expect(uploads.size).toBe(0);
  });

  it('lets an admin upload to any brand', async () => {
    const res = await call(
      'POST',
      '/brands/dr/shorts',
      { files: [{ name: 'clip.mp4', size: 10 }] },
      accessFromGroups(['admin']),
    );
    expect(res.statusCode).toBe(201);
  });

  it('404s a brand that is not in the deployment', async () => {
    const res = await call('GET', '/brands/nope/shorts', undefined, accessFromGroups(['admin']));
    expect(res.statusCode).toBe(404);
  });
});

describe('the form context', () => {
  it('names the brand’s channels and its episodes', async () => {
    store.seed(
      'catalog/cc/episodes/aaaaaaaaaaaaaaaa.json',
      JSON.stringify({ title: 'Episode 29', pubDate: '2026-11-06T04:00:00Z', guid: 'g-29' }),
    );
    store.seed(
      'catalog/cc/episodes/bbbbbbbbbbbbbbbb.json',
      JSON.stringify({ title: 'Episode 30', pubDate: '2026-11-13T04:00:00Z', guid: 'g-30' }),
    );
    const res = await call('GET', '/brands/cc/shorts');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      brand: 'cc',
      title: 'Chaotic Commits',
      outlets: [{ id: 'youtube', label: 'Chaotic Commits' }],
      maxFiles: MAX_BATCH_FILES,
    });
    // Newest first: a clip usually comes from the episode just finished.
    expect((res.body as { episodes: { title: string }[] }).episodes.map((e) => e.title)).toEqual([
      'Episode 30',
      'Episode 29',
    ]);
  });

  it('serves a brand that has no feed', async () => {
    const res = await call('GET', '/brands/dr/shorts', undefined, accessFromGroups(['admin']));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outlets: [{ id: 'main' }], episodes: [] });
  });
});

describe('opening a batch', () => {
  it('signs one multipart upload per file, under one batch id', async () => {
    const res = await call('POST', '/brands/cc/shorts', {
      files: [
        { name: 'clip-01.mp4', size: 2048 },
        { name: 'clip-01.jpg', size: 512 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ batchId: BATCH });
    expect([...uploads.values()].map((u) => u.key)).toEqual([
      `${PREFIX}clip-01.mp4`,
      `${PREFIX}clip-01.jpg`,
    ]);
    expect([...uploads.values()].map((u) => u.contentType)).toEqual(['video/mp4', 'image/jpeg']);
  });

  it('refuses names a batch cannot hold, and a batch with no video', async () => {
    for (const files of [
      [{ name: 'clip 01.mp4', size: 10 }],
      [{ name: '../escape.mp4', size: 10 }],
      [{ name: 'notes.txt', size: 10 }],
      [{ name: SHORTS_MANIFEST_FILE, size: 10 }],
      [{ name: 'episode.json', size: 10 }],
      [{ name: 'cover.jpg', size: 10 }],
      [
        { name: 'clip.mp4', size: 10 },
        { name: 'clip.mp4', size: 10 },
      ],
    ]) {
      const res = await call('POST', '/brands/cc/shorts', { files });
      expect(res.statusCode, JSON.stringify(files)).toBe(400);
    }
    expect(uploads.size).toBe(0);
  });

  it('caps how many files one batch carries', async () => {
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => ({
      name: `clip-${i}.mp4`,
      size: 10,
    }));
    expect((await call('POST', '/brands/cc/shorts', { files })).statusCode).toBe(400);
  });
});

describe('sending the bytes', () => {
  it('signs parts and completes a file', async () => {
    const { files } = await uploaded();
    const signed = await call('POST', `/brands/cc/shorts/${BATCH}/parts`, {
      name: 'clip-01.mp4',
      uploadId: files[0]!.uploadId,
      parts: [1, 2],
    });
    expect(signed.statusCode).toBe(200);
    expect(Object.keys((signed.body as { urls: Record<string, string> }).urls)).toEqual(['1', '2']);

    const done = await call('POST', `/brands/cc/shorts/${BATCH}/files`, {
      name: 'clip-01.mp4',
      uploadId: files[0]!.uploadId,
      parts: [{ partNumber: 1, etag: 'e1' }],
    });
    expect(done.statusCode).toBe(200);
  });

  it('refuses to write once the manifest is in place', async () => {
    const { files } = await uploaded();
    store.seed(PREFIX + SHORTS_MANIFEST_FILE, '{}');
    for (const action of ['parts', 'files']) {
      const res = await call('POST', `/brands/cc/shorts/${BATCH}/${action}`, {
        name: 'clip-01.mp4',
        uploadId: files[0]!.uploadId,
        parts: action === 'parts' ? [1] : [{ partNumber: 1, etag: 'e1' }],
      });
      expect(res.statusCode).toBe(409);
    }
  });

  it('rejects a bad batch id rather than guessing a key', async () => {
    expect((await call('GET', '/brands/cc/shorts/../../etc')).statusCode).toBe(400);
  });
});

describe('submitting the manifest', () => {
  it('writes shorts.json last, with the outlet resolved', async () => {
    await uploaded(['clip-01.mp4', 'clip-01.jpg']);
    const res = await call('POST', `/brands/cc/shorts/${BATCH}/complete`, {
      kind: 'short',
      defaults: { description: 'Full episode in the description.', tags: ['podcast'] },
      shorts: [clip({ thumbnail: 'clip-01.jpg', publishAt: '2026-12-01T17:00:00Z' })],
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ batchId: BATCH, status: 'queued', outlet: 'youtube' });
    expect(store.json(PREFIX + SHORTS_MANIFEST_FILE)).toEqual({
      schemaVersion: 1,
      brand: 'cc',
      kind: 'short',
      outlet: 'youtube',
      defaults: { description: 'Full episode in the description.', tags: ['podcast'] },
      shorts: [
        {
          file: 'clip-01.mp4',
          title: 'The bus factor nobody admits to',
          thumbnail: 'clip-01.jpg',
          publishAt: '2026-12-01T17:00:00Z',
        },
      ],
    });
  });

  it('is submitted once; a second attempt changes nothing', async () => {
    await uploaded();
    const body = { shorts: [clip()] };
    expect((await call('POST', `/brands/cc/shorts/${BATCH}/complete`, body)).statusCode).toBe(202);
    const again = await call('POST', `/brands/cc/shorts/${BATCH}/complete`, {
      shorts: [clip({ title: 'A different title' })],
    });
    expect(again.statusCode).toBe(409);
    expect(store.json(PREFIX + SHORTS_MANIFEST_FILE)).toMatchObject({
      shorts: [{ title: 'The bus factor nobody admits to' }],
    });
  });

  it('writes nothing when a clip names a file that was not uploaded', async () => {
    await uploaded(['clip-01.mp4']);
    const res = await call('POST', `/brands/cc/shorts/${BATCH}/complete`, {
      shorts: [clip(), clip({ file: 'clip-02.mp4', title: 'Rebase and chill' })],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      errors: [expect.stringContaining('was not uploaded')],
    });
    expect(store.text(PREFIX + SHORTS_MANIFEST_FILE)).toBe(undefined);
  });

  it('writes nothing when a thumbnail is missing, is not an image, or a clip is not a video', async () => {
    await uploaded(['clip-01.mp4', 'clip-01.jpg']);
    for (const shorts of [
      [clip({ thumbnail: 'nope.jpg' })],
      [clip({ thumbnail: 'clip-01.mp4' })],
      [clip({ file: 'clip-01.jpg' })],
      [clip(), clip({ title: 'Same file twice' })],
    ]) {
      const res = await call('POST', `/brands/cc/shorts/${BATCH}/complete`, { shorts });
      expect(res.statusCode, JSON.stringify(shorts)).toBe(400);
    }
    expect(store.text(PREFIX + SHORTS_MANIFEST_FILE)).toBe(undefined);
  });

  it('reports a schema problem as a form error, not as a rejected batch', async () => {
    await uploaded();
    const res = await call('POST', `/brands/cc/shorts/${BATCH}/complete`, {
      shorts: [clip({ title: '' })],
    });
    expect(res.statusCode).toBe(400);
    expect(store.text(PREFIX + SHORTS_MANIFEST_FILE)).toBe(undefined);
  });

  it('refuses an outlet the brand does not have, and a brand with no channel', async () => {
    await uploaded();
    const wrong = await call('POST', `/brands/cc/shorts/${BATCH}/complete`, {
      outlet: 'nowhere',
      shorts: [clip()],
    });
    expect(wrong.statusCode).toBe(400);

    const admin = accessFromGroups(['admin']);
    await call('POST', '/brands/pod/shorts', { files: [{ name: 'c.mp4', size: 10 }] }, admin);
    store.seed(`inbox/pod/${BATCH}/c.mp4`, 'bytes');
    const noChannel = await call(
      'POST',
      `/brands/pod/shorts/${BATCH}/complete`,
      { shorts: [clip({ file: 'c.mp4' })] },
      admin,
    );
    expect(noChannel.statusCode).toBe(400);
    expect(noChannel.body).toMatchObject({ error: expect.stringContaining('no YouTube channel') });
  });
});

describe('the batch status', () => {
  it('follows the upload through to the ingest’s verdict', async () => {
    expect((await call('GET', `/brands/cc/shorts/${BATCH}`)).statusCode).toBe(404);
    await uploaded();
    expect((await call('GET', `/brands/cc/shorts/${BATCH}`)).body).toMatchObject({
      status: 'uploading',
    });
    await call('POST', `/brands/cc/shorts/${BATCH}/complete`, { shorts: [clip()] });
    expect((await call('GET', `/brands/cc/shorts/${BATCH}`)).body).toMatchObject({
      status: 'queued',
    });
    store.seed(
      layout.inboxStatus('cc', BATCH),
      JSON.stringify({
        batchId: BATCH,
        brand: 'cc',
        status: 'ingested',
        outlet: 'youtube',
        items: [{ id: 'the-bus-factor-1234abcd', title: 'The bus factor nobody admits to' }],
        errors: [],
      }),
    );
    expect((await call('GET', `/brands/cc/shorts/${BATCH}`)).body).toMatchObject({
      status: 'ingested',
      items: [{ id: 'the-bus-factor-1234abcd' }],
    });
  });
});

describe('routing', () => {
  it('leaves the episode routes alone and 404s the rest', async () => {
    for (const [method, path] of [
      ['GET', '/brands/cc'],
      ['POST', '/brands/cc/shorts/extra/bits/here'],
      ['DELETE', '/brands/cc/shorts'],
    ] as const) {
      const res = await call(method, path, {}, accessFromGroups(['admin']));
      expect([400, 404, 405]).toContain(res.statusCode);
    }
  });
});
