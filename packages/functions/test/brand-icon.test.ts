import { beforeEach, describe, expect, it } from 'vitest';
import { accessFromGroups, layout, metricKeys, type Access } from '@darkrelay/core';
import { route, type BrandDeps } from '../src/brands/api';
import { MemoryStore } from './memory-store';

const NOW = new Date('2026-11-13T12:00:00Z');

/**
 * A PNG header of the given size. `checkIconImage` reads the pixel size out
 * of the header and never decodes the image, so this is a whole icon as far
 * as the API is concerned.
 */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

const data = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const show = (slug: string) =>
  JSON.stringify({
    schemaVersion: 1,
    slug,
    status: 'live',
    title: `The ${slug} show`,
    description: 'd',
    link: 'https://example.com',
    language: 'en',
    author: 'a',
    owner: { name: 'a', email: 'a@example.com' },
    image: { key: `${slug}/cover.jpg` },
    categories: [{ text: 'Technology' }],
    explicit: false,
    podcastGuid: '23f35153-ba05-5a2c-9d23-8c51b427723c',
  });

const brand = (slug: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    slug,
    name: slug.toUpperCase(),
    outlets: [{ kind: 'youtube', id: 'youtube', connection: slug }],
    ...over,
  });

let store: MemoryStore;
let deps: BrandDeps;
let meta: Record<string, unknown>[];

beforeEach(() => {
  store = new MemoryStore();
  store.seed(layout.brandConfig('cc'), brand('cc'));
  meta = [];
  deps = {
    store,
    saveMeta: async (item) => void meta.push(item),
    publicBaseUrl: 'https://media.example',
    now: () => NOW,
  };
});

const uploader = accessFromGroups(['uploader:cc']);
const call = (method: string, path: string, body?: unknown, access: Access = uploader) =>
  route(deps, { method, path, body, access });

const icon = (bytes = png(512, 512), filename = 'icon.png') =>
  call('POST', '/brands/cc/icon', { filename, data: data(bytes) });

describe('roles', () => {
  it('403s viewers, uploaders of other brands and users with no role', async () => {
    for (const groups of [[], ['viewer:cc'], ['uploader:dd'], ['uploader']]) {
      const res = await call(
        'POST',
        '/brands/cc/icon',
        { data: data(png(512, 512)) },
        accessFromGroups(groups),
      );
      expect(res.statusCode).toBe(403);
    }
    expect(store.json(layout.brandConfig('cc')).icon).toBeUndefined();
    expect(meta).toEqual([]);
  });

  it('lets an admin change any brand', async () => {
    const res = await call(
      'POST',
      '/brands/cc/icon',
      { data: data(png(512, 512)) },
      accessFromGroups(['admin']),
    );
    expect(res.statusCode).toBe(200);
  });
});

describe('routing', () => {
  it('answers the brand name and the older show name alike', async () => {
    expect((await call('POST', '/shows/cc/icon', { data: data(png(512, 512)) })).statusCode).toBe(
      200,
    );
  });

  it('404s anything else, and never reads a bad slug as a brand', async () => {
    expect((await call('GET', '/brands/cc/icon')).statusCode).toBe(404);
    expect((await call('POST', '/brands/cc')).statusCode).toBe(404);
    expect((await call('POST', '/brands/cc/icon/extra')).statusCode).toBe(404);
    expect((await call('POST', '/other/cc/icon')).statusCode).toBe(404);
    expect((await call('POST', '/brands/Not A Slug/icon')).statusCode).toBe(400);
  });

  it('404s a brand this deployment does not have', async () => {
    const res = await call(
      'POST',
      '/brands/dd/icon',
      { data: data(png(512, 512)) },
      accessFromGroups(['admin']),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('the icon', () => {
  it('stores it under a key derived from its bytes, and points the brand at it', async () => {
    const res = await icon();
    expect(res.statusCode).toBe(200);
    const body = res.body as { iconKey: string; iconUrl: string };
    expect(body.iconKey).toMatch(/^cc\/icon-[0-9a-f]{8}\.png$/);
    expect(body.iconUrl).toBe(`https://media.example/${body.iconKey}`);

    const stored = store.objects.get(`public/${body.iconKey}`)!;
    expect(stored.body).toEqual(png(512, 512));
    expect(stored.opts.contentType).toBe('image/png');
    expect(stored.opts.cacheControl).toMatch(/max-age=86400/);

    const config = store.json(layout.brandConfig('cc'));
    expect(config.icon).toEqual({ key: body.iconKey });
    expect(config.updatedAt).toBe(NOW.toISOString());
    // Everything else about the brand is left exactly as it was.
    expect(config.name).toBe('CC');
    expect(config.outlets).toHaveLength(1);
  });

  it('writes the brand row, so the switcher shows the new icon at once', async () => {
    const { iconKey } = (await icon()).body as { iconKey: string };
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({
      pk: metricKeys.brandsPk,
      sk: metricKeys.brandMeta('cc'),
      show: 'cc',
      title: 'CC',
      iconKey,
    });
  });

  it('names a JPEG by its bytes, not by the file it arrived as', async () => {
    // SOI, then a start-of-frame saying 512x512.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x02, 0x00, 0x03,
    ]);
    const res = await icon(jpeg, 'icon.png');
    const { iconKey } = res.body as { iconKey: string };
    expect(iconKey).toMatch(/\.jpg$/);
    expect(store.objects.get(`public/${iconKey}`)!.opts.contentType).toBe('image/jpeg');
  });

  it('keeps the icon it has when the new one is the wrong shape', async () => {
    const res = await icon(png(1280, 720), 'banner.png');
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      errors: ['banner.png is 1280x720; a brand icon must be square'],
    });
    expect(store.json(layout.brandConfig('cc')).icon).toBeUndefined();
    expect(meta).toEqual([]);
  });

  it('rejects anything that is not a readable PNG or JPEG', async () => {
    const res = await icon(new Uint8Array([1, 2, 3]), 'icon.svg');
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ errors: ['icon.svg is not a readable JPEG or PNG'] });
  });

  it('rejects a body that is not base64, and one with no image at all', async () => {
    expect((await call('POST', '/brands/cc/icon', { data: 'not base64!' })).statusCode).toBe(400);
    expect((await call('POST', '/brands/cc/icon', {})).statusCode).toBe(400);
    expect((await call('POST', '/brands/cc/icon', undefined)).statusCode).toBe(400);
  });

  it('refuses an icon over the size limit without decoding it', async () => {
    const huge = 'A'.repeat(4 * 1024 ** 2);
    const res = await call('POST', '/brands/cc/icon', { filename: 'big.png', data: huge });
    expect(res.statusCode).toBe(400);
  });

  it('writes brand.json for a show the migration has not reached yet', async () => {
    store = new MemoryStore();
    store.seed(layout.showConfig('cc'), show('cc'));
    deps = { ...deps, store };
    const { iconKey } = (await icon()).body as { iconKey: string };
    const config = store.json(layout.brandConfig('cc'));
    // The brand derived from the feed, now with an icon of its own: the feed
    // config itself is untouched.
    expect(config).toMatchObject({ slug: 'cc', name: 'The cc show', icon: { key: iconKey } });
    expect(config.outlets.map((o: { kind: string }) => o.kind)).toEqual(['rss']);
    expect(store.text(layout.showConfig('cc'))).toBe(show('cc'));
  });

  it('leaves out the URL when the deployment has not told it the media base', async () => {
    deps = { ...deps, publicBaseUrl: undefined };
    expect((await icon()).body).toMatchObject({ iconUrl: undefined });
  });
});
