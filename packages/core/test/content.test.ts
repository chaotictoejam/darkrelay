import { describe, expect, it } from 'vitest';
import {
  ContentItem,
  ShortsManifest,
  contentFromEpisode,
  contentIdFor,
  dueForUpload,
  episodeId,
  needsReschedule,
  publicationFor,
  withPublication,
  type ContentItemInput,
  type PublicationState,
} from '../src';
import { episode } from './helpers';

const NOW = new Date('2026-11-12T10:00:00Z');

function item(over: Partial<ContentItemInput> = {}): ContentItem {
  return ContentItem.parse({
    schemaVersion: 1,
    id: 'clip-abcd1234',
    brand: 'cc',
    kind: 'short',
    title: 'A Short',
    media: { key: 'catalog/cc/content/clip-abcd1234/clip.mp4' },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  });
}

describe('ContentItem', () => {
  it('defaults the parts a hand-written batch leaves out', () => {
    const i = item();
    expect(i).toMatchObject({ description: '', tags: [], publications: [] });
    expect(i.parentId).toBeUndefined();
  });

  it('refuses copy YouTube would reject', () => {
    expect(ContentItem.safeParse({ ...item(), title: 'a'.repeat(101) }).success).toBe(false);
    expect(ContentItem.safeParse({ ...item(), title: 'Tags <b>' }).success).toBe(false);
    expect(ContentItem.safeParse({ ...item(), description: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('is a short or a video, never an episode: a feed owns those', () => {
    expect(ContentItem.safeParse({ ...item(), kind: 'video' }).success).toBe(true);
    expect(ContentItem.safeParse({ ...item(), kind: 'episode' }).success).toBe(false);
  });
});

describe('contentIdFor', () => {
  it('derives a readable, stable id from the file name', () => {
    expect(contentIdFor('Bus Factor Clip 3.mp4', 'b1')).toMatch(/^bus-factor-clip-3-[0-9a-f]{8}$/);
    expect(contentIdFor('clip.mp4', 'b1')).toBe(contentIdFor('clip.mp4', 'b1'));
  });

  it('keeps the same name in two batches apart', () => {
    expect(contentIdFor('clip.mp4', 'b1')).not.toBe(contentIdFor('clip.mp4', 'b2'));
  });

  it('copes with a name that has nothing usable in it', () => {
    expect(contentIdFor('???.mp4', 'b1')).toMatch(/^clip-[0-9a-f]{8}$/);
  });
});

describe('publications', () => {
  it('adds and replaces one outlet at a time', () => {
    const one = withPublication(item(), { outlet: 'youtube', state: 'planned', warnings: [] });
    const two = withPublication(one, { outlet: 'clips', state: 'planned', warnings: [] });
    expect(two.publications).toHaveLength(2);
    const moved = withPublication(two, {
      outlet: 'youtube',
      state: 'published',
      externalId: 'v1',
      warnings: [],
    });
    expect(moved.publications).toHaveLength(2);
    expect(publicationFor(moved, 'youtube')).toMatchObject({ state: 'published' });
    expect(publicationFor(moved, 'clips')).toMatchObject({ state: 'planned' });
  });
});

describe('dueForUpload', () => {
  const slot = (publishAt?: string, state: PublicationState = 'planned') =>
    item({
      publishAt,
      publications: [{ outlet: 'youtube', state, publishAt, warnings: [] }],
    });

  it('is due inside the lead time and not before', () => {
    expect(dueForUpload(slot('2026-11-14T10:00:00Z'), 'youtube', NOW, 3)).toBe(true);
    expect(dueForUpload(slot('2026-11-20T10:00:00Z'), 'youtube', NOW, 3)).toBe(false);
    expect(dueForUpload(slot('2026-11-20T10:00:00Z'), 'youtube', NOW, 10)).toBe(true);
  });

  it('is never due without a slot: a plan has to be approved first', () => {
    expect(dueForUpload(slot(undefined), 'youtube', NOW, 3)).toBe(false);
  });

  it('uploads a slot that has already passed rather than skipping it', () => {
    expect(dueForUpload(slot('2026-11-01T10:00:00Z'), 'youtube', NOW, 3)).toBe(true);
  });

  it('leaves alone anything already sent, and retries a failure', () => {
    for (const state of ['uploading', 'scheduled', 'published'] as PublicationState[]) {
      expect(dueForUpload(slot('2026-11-13T10:00:00Z', state), 'youtube', NOW, 3)).toBe(false);
    }
    expect(dueForUpload(slot('2026-11-13T10:00:00Z', 'failed'), 'youtube', NOW, 3)).toBe(true);
  });
});

describe('needsReschedule', () => {
  const scheduled = (publishAt: string, sentPublishAt?: string) =>
    item({
      publishAt,
      publications: [
        {
          outlet: 'youtube',
          state: 'scheduled',
          externalId: 'v1',
          publishAt,
          sentPublishAt,
          warnings: [],
        },
      ],
    });

  it('is true when the slot moved after the upload', () => {
    const at = '2026-11-20T10:00:00Z';
    expect(needsReschedule(scheduled(at, at), 'youtube')).toBe(false);
    expect(needsReschedule(scheduled(at, '2026-11-18T10:00:00Z'), 'youtube')).toBe(true);
  });

  it('ignores anything not scheduled on the platform', () => {
    expect(needsReschedule(item({ publishAt: '2026-11-20T10:00:00Z' }), 'youtube')).toBe(false);
  });
});

describe('ShortsManifest', () => {
  const manifest = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    shorts: [{ file: 'clip-01.mp4', title: 'Clip one' }],
    ...over,
  });

  it('defaults to Shorts and needs at least one', () => {
    expect(ShortsManifest.parse(manifest())).toMatchObject({ kind: 'short' });
    expect(ShortsManifest.safeParse(manifest({ shorts: [] })).success).toBe(false);
  });

  it('takes defaults for the whole batch and a slot per item', () => {
    const m = ShortsManifest.parse(
      manifest({
        defaults: { tags: ['chaotic'], parentId: 'guid-1' },
        shorts: [{ file: 'a.mp4', title: 'A', publishAt: '2026-11-20T15:00:00Z' }],
      }),
    );
    expect(m.defaults).toEqual({ tags: ['chaotic'], parentId: 'guid-1' });
    expect(m.shorts[0]!.publishAt).toBe('2026-11-20T15:00:00Z');
  });

  it('refuses a bad outlet id or slug', () => {
    expect(ShortsManifest.safeParse(manifest({ outlet: 'NOPE' })).success).toBe(false);
    expect(ShortsManifest.safeParse(manifest({ brand: 'Not A Slug' })).success).toBe(false);
  });
});

describe('contentFromEpisode', () => {
  it('reads an episode as content without storing anything', () => {
    const e = episode({
      guid: 'g-1',
      youtube: { videoId: 'v1', linkedAt: '2026-10-01T12:00:00Z' },
    });
    const view = contentFromEpisode('cc', e);
    expect(view).toMatchObject({
      kind: 'episode',
      id: episodeId('g-1'),
      brand: 'cc',
      title: 'Episode 1',
      publishAt: e.pubDate,
    });
    expect(view.publications).toEqual([
      expect.objectContaining({ outlet: 'youtube', state: 'published', externalId: 'v1' }),
    ]);
  });

  it('has no publications for an episode that never went to YouTube', () => {
    expect(contentFromEpisode('cc', episode()).publications).toEqual([]);
  });
});
