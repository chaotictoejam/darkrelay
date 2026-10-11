import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFeed,
  ImportError,
  importFeed,
  parseDuration,
  parseFeedXml,
  text,
  validateFeed,
} from '../src';

const anchor = readFileSync(new URL('./fixtures/anchor-style.xml', import.meta.url), 'utf8');
const SOURCE = 'https://anchor.fm/s/abc123/podcast/rss';
const NOW = new Date('2026-10-11T00:00:00Z');

describe('importFeed', () => {
  const result = importFeed(anchor, { sourceUrl: SOURCE, slug: 'example', now: NOW });

  it('imports the show as a draft with a GUID derived from the source URL', () => {
    expect(result.show.status).toBe('draft');
    expect(result.show.podcastGuid).toBe('f448eb3f-68c9-58e4-b556-884e9b1913cd');
    expect(result.show.title).toBe('Example Show');
    expect(result.show.owner.email).toBe('host@example.com');
    expect(result.show.image).toEqual({
      url: 'https://d3t3ozftmdmh3i.cloudfront.net/example/cover.jpg',
    });
    expect(result.warnings.join('\n')).toMatch(/no <podcast:guid>/);
  });

  it('preserves every episode guid exactly, including ones that look numeric', () => {
    expect(result.episodes.map((e) => e.guid)).toEqual([
      '4f1c2b3a-0000-4000-8000-000000000002',
      '007',
      'https://example.com/trailer',
    ]);
    expect(result.episodes.map((e) => e.guidIsPermaLink)).toEqual([false, false, undefined]);
  });

  it('keeps media on the old host and maps episode fields', () => {
    const ep = result.episodes[0]!;
    expect(ep.enclosure).toEqual({
      asset: {
        url: 'https://anchor.fm/s/abc123/podcast/play/2/https%3A%2F%2Fd3ctxlq1ktw2nl.cloudfront.net%2Fstaging%2F2026-9-9%2Fep2.mp3',
      },
      length: 40513262,
      type: 'audio/mpeg',
    });
    // Inside CDATA, &amp; is literal text; keep it exactly as the source has it.
    expect(ep.title).toBe('Ep 2: Bugs &amp; Branches');
    expect(ep.durationSeconds).toBe(2533);
    expect(ep.season).toBe(1);
    expect(ep.episode).toBe(2);
    expect(ep.pubDate).toBe('2026-10-09T10:00:00.000Z');
    expect(result.episodes[2]!.episodeType).toBe('trailer');
  });

  it('round-trips: the rebuilt feed is valid and has the same guids and enclosures', () => {
    const xml = buildFeed({
      show: result.show,
      episodes: result.episodes,
      baseUrl: 'https://media.example.com',
      now: NOW,
    });
    expect(validateFeed(xml).errors).toEqual([]);
    const original = parseFeedXml(anchor).items;
    const rebuilt = parseFeedXml(xml).items;
    expect(rebuilt.map((i) => text(i['guid']))).toEqual(original.map((i) => text(i['guid'])));
    expect(rebuilt.map((i) => (i['enclosure'] as Record<string, string>)['@_url'])).toEqual(
      original.map((i) => (i['enclosure'] as Record<string, string>)['@_url']),
    );
    expect(text(parseFeedXml(xml).channel['podcast:guid'])).toBe(result.show.podcastGuid);
  });

  it('keeps a declared podcast:guid instead of deriving one', () => {
    const withGuid = anchor.replace(
      '<itunes:type>',
      '<podcast:guid>11111111-2222-5333-8444-555555555555</podcast:guid><itunes:type>',
    );
    const r = importFeed(withGuid, { sourceUrl: SOURCE, slug: 'example', now: NOW });
    expect(r.show.podcastGuid).toBe('11111111-2222-5333-8444-555555555555');
  });

  it('asks for overrides when required show fields are missing', () => {
    const noOwner = anchor.replace(/<itunes:owner>.*?<\/itunes:owner>/, '');
    expect(() => importFeed(noOwner, { sourceUrl: SOURCE, slug: 'example' })).toThrow(ImportError);
    const r = importFeed(noOwner, {
      sourceUrl: SOURCE,
      slug: 'example',
      overrides: { owner: { name: 'Host', email: 'host@example.com' } },
    });
    expect(r.show.owner.email).toBe('host@example.com');
  });

  it('skips duplicate guids, keeping the first', () => {
    const dup = anchor.replace(
      '<guid isPermaLink="false">007</guid>',
      '<guid isPermaLink="false">4f1c2b3a-0000-4000-8000-000000000002</guid>',
    );
    const r = importFeed(dup, { sourceUrl: SOURCE, slug: 'example', now: NOW });
    expect(r.episodes).toHaveLength(2);
    expect(r.warnings.join('\n')).toMatch(/duplicate guid/);
  });
});

describe('parseDuration', () => {
  it.each([
    ['00:42:13', 2533],
    ['42:13', 2533],
    ['1834', 1834],
    ['59.6', 60],
    ['1h', undefined],
    [undefined, undefined],
  ])('%s -> %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });
});
