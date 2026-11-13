import { layout } from '@darkrelay/core';
import { describe, expect, it } from 'vitest';
import { listBrands, loadBrand } from '../src/lib/brands';
import { MemoryStore } from './memory-store';

const show = (slug: string, over: Record<string, unknown> = {}) =>
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
    ...over,
  });

const brand = (slug: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    slug,
    name: slug.toUpperCase(),
    outlets: [{ kind: 'youtube', id: 'youtube', connection: slug }],
    ...over,
  });

describe('loadBrand', () => {
  it('reads a stored brand', async () => {
    const store = new MemoryStore();
    store.seed(layout.brandConfig('cc'), brand('cc'));
    const b = await loadBrand(store, 'cc');
    expect(b).toMatchObject({ slug: 'cc', name: 'CC' });
  });

  it('derives the brand of a show that has not been migrated', async () => {
    const store = new MemoryStore();
    store.seed(layout.showConfig('cc'), show('cc', { youtube: { connection: 'cc-yt' } }));
    const b = await loadBrand(store, 'cc');
    expect(b).toMatchObject({ slug: 'cc', name: 'The cc show', icon: { key: 'cc/cover.jpg' } });
    expect(b?.outlets.map((o) => o.kind)).toEqual(['rss', 'youtube']);
  });

  it('falls back to the show when brand.json is invalid, and says so', async () => {
    const store = new MemoryStore();
    store.seed(layout.brandConfig('cc'), '{"schemaVersion":1,"slug":"cc"}');
    store.seed(layout.showConfig('cc'), show('cc'));
    const logs: string[] = [];
    const b = await loadBrand(store, 'cc', (m) => logs.push(m));
    expect(b).toMatchObject({ name: 'The cc show' });
    expect(logs.join()).toMatch(/Invalid brand.json/);
  });

  it('is undefined for a slug with neither file', async () => {
    expect(await loadBrand(new MemoryStore(), 'nope')).toBeUndefined();
  });
});

describe('listBrands', () => {
  it('lists brands with a feed, with only a channel, or with both', async () => {
    const store = new MemoryStore();
    store.seed(layout.showConfig('cc'), show('cc'));
    store.seed(layout.brandConfig('cc'), brand('cc', { name: 'Chaotic Commits' }));
    store.seed(layout.brandConfig('drjoanneskiles'), brand('drjoanneskiles'));
    store.seed(layout.showConfig('unmigrated'), show('unmigrated'));
    store.seed(layout.episodeManifest('cc', 'abc'), '{}');

    expect((await listBrands(store)).map((b) => [b.slug, b.name])).toEqual([
      ['cc', 'Chaotic Commits'],
      ['drjoanneskiles', 'DRJOANNESKILES'],
      ['unmigrated', 'The unmigrated show'],
    ]);
  });

  it('skips a slug whose files cannot be parsed', async () => {
    const store = new MemoryStore();
    store.seed(layout.showConfig('broken'), '{"slug":"broken"}');
    store.seed(layout.showConfig('cc'), show('cc'));
    const logs: string[] = [];
    expect((await listBrands(store, (m) => logs.push(m))).map((b) => b.slug)).toEqual(['cc']);
    expect(logs.join()).toMatch(/Invalid show.json/);
  });
});
