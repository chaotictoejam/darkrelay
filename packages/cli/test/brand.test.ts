import { describe, expect, it } from 'vitest';
import { manyBrands, oneBrand } from '../src/brands';
import { ShortsManifest } from '@darkrelay/core';
import { buildOutlet, catalogEntries, iconKey, planMigration } from '../src/commands/brand';
import { planBatch } from '../src/commands/shorts';

const NOW = new Date('2026-11-12T10:00:00Z');

describe('oneBrand', () => {
  it('accepts --brand, and --show as its old name', () => {
    expect(oneBrand({ brand: 'cc' })).toBe('cc');
    expect(oneBrand({ show: 'cc' })).toBe('cc');
    expect(oneBrand({ brand: 'cc', show: 'cc' })).toBe('cc');
  });

  it('refuses two different slugs, or neither', () => {
    expect(() => oneBrand({ brand: 'cc', show: 'dd' })).toThrow(/different brands/);
    expect(() => oneBrand({})).toThrow(/--brand/);
  });
});

describe('manyBrands', () => {
  it('merges both flags and drops duplicates', () => {
    expect(manyBrands({ brand: ['cc'], show: ['cc', 'dd'] })).toEqual(['cc', 'dd']);
    expect(manyBrands({})).toEqual([]);
  });
});

describe('catalogEntries', () => {
  it('pairs brand and feed configs by slug and ignores other keys', () => {
    expect(
      catalogEntries([
        'catalog/chaoticcommits/show.json',
        'catalog/chaoticcommits/brand.json',
        'catalog/chaoticcommits/episodes/abc.json',
        'catalog/drjoanneskiles/brand.json',
        'catalog/old-show/show.json',
        'catalog/old-show/feed.preview.xml',
        'public/chaoticcommits/feed.xml',
      ]),
    ).toEqual([
      { slug: 'chaoticcommits', brand: true, show: true },
      { slug: 'drjoanneskiles', brand: true, show: false },
      { slug: 'old-show', brand: false, show: true },
    ]);
  });
});

describe('planMigration', () => {
  const entries = [
    { slug: 'chaoticcommits', brand: false, show: true },
    { slug: 'drjoanneskiles', brand: true, show: false },
    { slug: 'done', brand: true, show: true },
  ];

  it('writes a brand for every show that has none', () => {
    expect(planMigration(entries)).toEqual({
      create: ['chaoticcommits'],
      skip: [
        { slug: 'drjoanneskiles', reason: 'no feed to migrate' },
        { slug: 'done', reason: 'already a brand' },
      ],
    });
  });

  it('rewrites an existing brand only with --force', () => {
    expect(planMigration(entries, { force: true }).create).toEqual(['chaoticcommits', 'done']);
  });

  it('migrates one named brand', () => {
    expect(planMigration(entries, { slug: 'chaoticcommits' })).toEqual({
      create: ['chaoticcommits'],
      skip: [],
    });
    expect(() => planMigration(entries, { slug: 'nope' })).toThrow(/No brand or show "nope"/);
  });
});

describe('buildOutlet', () => {
  it('defaults an rss outlet to the brand its own feed', () => {
    expect(buildOutlet('chaoticcommits', { kind: 'rss' }, NOW)).toEqual({
      kind: 'rss',
      id: 'rss',
      show: 'chaoticcommits',
      addedAt: NOW.toISOString(),
    });
  });

  it('points an rss outlet at another feed with --feed', () => {
    expect(buildOutlet('cc', { kind: 'rss', feed: 'cc-video', id: 'video' }, NOW)).toMatchObject({
      id: 'video',
      show: 'cc-video',
    });
  });

  it('wraps a YouTube connection', () => {
    expect(
      buildOutlet('cc', { kind: 'youtube', connection: 'chaotic-commits', label: 'Main' }, NOW),
    ).toEqual({
      kind: 'youtube',
      id: 'youtube',
      connection: 'chaotic-commits',
      label: 'Main',
      addedAt: NOW.toISOString(),
    });
  });

  it('refuses a YouTube outlet with no connection, and an unknown kind', () => {
    expect(() => buildOutlet('cc', { kind: 'youtube' }, NOW)).toThrow(/--connection/);
    expect(() => buildOutlet('cc', { kind: 'tiktok' }, NOW)).toThrow(/--kind must be one of/);
    expect(() => buildOutlet('cc', {}, NOW)).toThrow(/--kind must be one of/);
  });

  it('validates platform outlets through the schema', () => {
    expect(
      buildOutlet('cc', { kind: 'spotify', url: 'https://open.spotify.com/show/x' }, NOW).id,
    ).toBe('spotify');
    expect(() => buildOutlet('cc', { kind: 'apple', url: 'not a url' }, NOW)).toThrow(
      /Invalid outlet/,
    );
    expect(() => buildOutlet('cc', { kind: 'rss', id: 'Not An Id' }, NOW)).toThrow(
      /Invalid outlet/,
    );
  });
});

describe('iconKey', () => {
  it('addresses the icon by its content, so a replacement is never cached', () => {
    const a = iconKey('cc', new Uint8Array([1, 2, 3]), 'icon.png');
    const b = iconKey('cc', new Uint8Array([4, 5, 6]), 'icon.png');
    expect(a).toMatch(/^cc\/icon-[0-9a-f]{8}\.png$/);
    expect(a).not.toBe(b);
    expect(iconKey('cc', new Uint8Array([1]), 'ICON.JPEG')).toMatch(/\.jpg$/);
  });
});

describe('planBatch', () => {
  const manifest = (shorts: { file: string; title: string; thumbnail?: string }[]) =>
    ShortsManifest.parse({ schemaVersion: 1, shorts });

  it('carries every video and every thumbnail the manifest names, once', () => {
    const plan = planBatch(
      manifest([
        { file: 'a.mp4', title: 'A', thumbnail: 'cover.jpg' },
        { file: 'b.mp4', title: 'B', thumbnail: 'cover.jpg' },
      ]),
      '/batch',
    );
    expect(plan.files.map((f) => f.name)).toEqual(['a.mp4', 'cover.jpg', 'b.mp4']);
    expect(plan.files[0]!.path).toBe('/batch/a.mp4');
  });

  it('refuses paths, so a batch cannot reach outside its own directory', () => {
    expect(() => planBatch(manifest([{ file: '../secrets.mp4', title: 'A' }]), '/batch')).toThrow(
      /named without a path/,
    );
    expect(() => planBatch(manifest([{ file: 'sub/a.mp4', title: 'A' }]), '/batch')).toThrow(
      /named without a path/,
    );
  });
});
