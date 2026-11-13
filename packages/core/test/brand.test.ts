import { describe, expect, it } from 'vitest';
import {
  BrandConfig,
  brandFromShow,
  feedOutlet,
  feedShow,
  findOutlet,
  metricKeys,
  outletName,
  outletSource,
  outletsOfKind,
  withOutlet,
  withoutOutlet,
  youtubeDefaults,
  type BrandConfigInput,
  type YouTubeOutlet,
} from '../src';
import { show } from './helpers';

const NOW = new Date('2026-11-12T10:00:00Z');

function brand(overrides: Partial<BrandConfigInput> = {}): BrandConfig {
  return BrandConfig.parse({
    schemaVersion: 1,
    slug: 'example',
    name: 'Example',
    outlets: [{ kind: 'rss', id: 'rss', show: 'example' }],
    ...overrides,
  });
}

describe('brandFromShow', () => {
  it('keeps the slug and makes the feed the first rss outlet', () => {
    const b = brandFromShow(show({ slug: 'chaoticcommits', title: 'Chaotic Commits' }), NOW);
    expect(b.slug).toBe('chaoticcommits');
    expect(b.name).toBe('Chaotic Commits');
    expect(b.icon).toEqual({ key: 'example/cover.jpg' });
    expect(b.outlets).toEqual([
      { kind: 'rss', id: 'rss', show: 'chaoticcommits', addedAt: NOW.toISOString() },
    ]);
    // The feed, its guid and its episode guids are all addressed by this slug.
    expect(feedShow(b)).toBe('chaoticcommits');
    expect(metricKeys.brandSeries(b.slug)).toBe(metricKeys.showSeries('chaoticcommits'));
  });

  it("adds the show's YouTube connection as a second outlet", () => {
    const b = brandFromShow(
      show({ slug: 'cc', youtube: { connection: 'chaotic-commits', categoryId: '27' } }),
      NOW,
    );
    expect(outletsOfKind(b, 'youtube')).toEqual([
      { kind: 'youtube', id: 'youtube', connection: 'chaotic-commits', addedAt: NOW.toISOString() },
    ]);
    // The connection is wrapped, not copied: upload settings stay in show.json.
    expect(outletsOfKind(b, 'youtube')[0]).not.toHaveProperty('defaults');
  });

  it('migrates a show without YouTube to a single outlet', () => {
    expect(brandFromShow(show(), NOW).outlets).toHaveLength(1);
  });
});

describe('BrandConfig', () => {
  it('accepts a brand with no feed at all', () => {
    const b = brand({
      slug: 'drjoanneskiles',
      name: 'Dr. Joanne Skiles',
      outlets: [{ kind: 'youtube', id: 'youtube', connection: 'drjoanneskiles' }],
    });
    expect(feedOutlet(b)).toBeUndefined();
    expect(feedShow(b)).toBeUndefined();
  });

  it('allows more than one outlet of a kind', () => {
    const b = brand({
      outlets: [
        { kind: 'youtube', id: 'main', connection: 'cc-main' },
        { kind: 'youtube', id: 'clips', connection: 'cc-clips' },
      ],
    });
    expect(outletsOfKind(b, 'youtube').map((o) => o.id)).toEqual(['main', 'clips']);
  });

  it('refuses two outlets with the same id', () => {
    const r = BrandConfig.safeParse({
      schemaVersion: 1,
      slug: 'example',
      name: 'Example',
      outlets: [
        { kind: 'rss', id: 'feed', show: 'example' },
        { kind: 'youtube', id: 'feed', connection: 'example' },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/share the id "feed"/);
  });

  it('refuses a bad slug, outlet id or connection name', () => {
    expect(BrandConfig.safeParse({ ...brand(), slug: 'Not A Slug' }).success).toBe(false);
    expect(
      BrandConfig.safeParse({ ...brand(), outlets: [{ kind: 'rss', id: 'A', show: 'x' }] }).success,
    ).toBe(false);
    expect(
      BrandConfig.safeParse({
        ...brand(),
        outlets: [{ kind: 'youtube', id: 'yt', connection: 'Bad Name' }],
      }).success,
    ).toBe(false);
  });

  it('defaults outlets to an empty list', () => {
    expect(BrandConfig.parse({ schemaVersion: 1, slug: 'new', name: 'New' }).outlets).toEqual([]);
  });
});

describe('outlet helpers', () => {
  it('adds, replaces, finds and removes outlets', () => {
    const b = brand();
    const added = withOutlet(b, { kind: 'youtube', id: 'youtube', connection: 'cc' });
    expect(added.outlets).toHaveLength(2);
    const replaced = withOutlet(added, { kind: 'youtube', id: 'youtube', connection: 'cc2' });
    expect(replaced.outlets).toHaveLength(2);
    expect(findOutlet(replaced, 'youtube')).toMatchObject({ connection: 'cc2' });
    expect(withoutOutlet(replaced, 'youtube').outlets.map((o) => o.id)).toEqual(['rss']);
    // The input is never mutated: callers write the result.
    expect(b.outlets).toHaveLength(1);
  });

  it('maps every outlet kind onto an existing metric source', () => {
    expect(outletSource({ kind: 'rss', id: 'rss', show: 'x' })).toBe('cloudfront');
    expect(outletSource({ kind: 'youtube', id: 'yt', connection: 'x' })).toBe('youtube');
    expect(outletSource({ kind: 'spotify', id: 'spotify' })).toBe('spotify-csv');
    expect(outletSource({ kind: 'apple', id: 'apple' })).toBe('apple-csv');
  });

  it('names outlets, preferring a label', () => {
    expect(outletName({ kind: 'rss', id: 'rss', show: 'cc' })).toBe('RSS feed (cc)');
    expect(outletName({ kind: 'youtube', id: 'yt', connection: 'cc' })).toBe('YouTube (cc)');
    expect(
      outletName({ kind: 'youtube', id: 'yt', connection: 'cc', channelTitle: 'Chaotic Commits' }),
    ).toBe('Chaotic Commits');
    expect(outletName({ kind: 'rss', id: 'rss', show: 'cc', label: 'Main feed' })).toBe(
      'Main feed',
    );
  });
});

describe('youtubeDefaults', () => {
  const outlet = (o: Partial<YouTubeOutlet> = {}): YouTubeOutlet => ({
    kind: 'youtube',
    id: 'youtube',
    connection: 'chaotic-commits',
    ...o,
  });

  it('falls back to the feed config, so episodes upload exactly as they do now', () => {
    const s = show({
      youtube: {
        connection: 'chaotic-commits',
        categoryId: '27',
        privacy: 'unlisted',
        playlistId: 'PL123',
      },
    });
    expect(youtubeDefaults(outlet(), s)).toEqual({
      upload: true,
      privacy: 'unlisted',
      categoryId: '27',
      tags: [],
      playlistId: 'PL123',
      descriptionFooter: undefined,
    });
  });

  it("prefers the outlet's own settings", () => {
    const s = show({ youtube: { connection: 'chaotic-commits', categoryId: '27' } });
    const d = youtubeDefaults(outlet({ defaults: { categoryId: '28', upload: false } }), s);
    expect(d.categoryId).toBe('28');
    expect(d.upload).toBe(false);
  });

  it('ignores a feed config for a different channel', () => {
    const s = show({ youtube: { connection: 'someone-else', categoryId: '27' } });
    expect(youtubeDefaults(outlet(), s).categoryId).toBe('22');
  });

  it('works with no feed config at all', () => {
    expect(youtubeDefaults(outlet())).toEqual({
      upload: true,
      privacy: 'public',
      categoryId: '22',
      tags: [],
      playlistId: undefined,
      descriptionFooter: undefined,
    });
  });
});
