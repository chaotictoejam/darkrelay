import { describe, expect, it } from 'vitest';
import { buildFeed, parseFeedXml, text, attr, validateFeed } from '../src';
import { BASE_URL, episode, show } from './helpers';

const NOW = new Date('2026-10-11T00:00:00Z');

describe('buildFeed', () => {
  it('produces a feed that passes validation with no errors or warnings', () => {
    const xml = buildFeed({
      show: show(),
      episodes: [
        episode({
          season: 1,
          episode: 1,
          transcripts: [{ asset: { key: 'example/abc/v1/transcript.vtt' }, type: 'text/vtt' }],
          chapters: { key: 'example/abc/v1/chapters.json' },
          persons: [{ name: 'Example Host', role: 'host' }],
        }),
      ],
      baseUrl: BASE_URL,
      now: NOW,
    });
    const result = validateFeed(xml);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('emits Podcasting 2.0 and iTunes tags with resolved URLs', () => {
    const xml = buildFeed({
      show: show(),
      episodes: [
        episode({
          transcripts: [{ asset: { key: 'example/abc/v1/transcript.vtt' }, type: 'text/vtt' }],
          chapters: { key: 'example/abc/v1/chapters.json' },
        }),
      ],
      baseUrl: BASE_URL,
      now: NOW,
    });
    const { channel, items } = parseFeedXml(xml);
    expect(text(channel['podcast:guid'])).toBe('23f35153-ba05-5a2c-9d23-8c51b427723c');
    expect(attr(channel['itunes:image'], 'href')).toBe(`${BASE_URL}/example/cover.jpg`);
    const item = items[0]!;
    expect(attr(item['enclosure'], 'url')).toBe(`${BASE_URL}/example/abc/v1/audio.mp3`);
    expect(attr(item['podcast:transcript'], 'url')).toBe(
      `${BASE_URL}/example/abc/v1/transcript.vtt`,
    );
    expect(attr(item['podcast:chapters'], 'type')).toBe('application/json+chapters');
    expect(text(item['description'])).toBe('<p>Notes & things</p>');
  });

  it('keeps guids byte-for-byte and the isPermaLink attribute only when set', () => {
    const xml = buildFeed({
      show: show(),
      episodes: [
        episode({ guid: '007', guidIsPermaLink: undefined }),
        episode({
          guid: ' spaced&odd<guid> ',
          guidIsPermaLink: true,
          pubDate: '2026-10-02T00:00:00Z',
        }),
      ],
      baseUrl: BASE_URL,
      now: NOW,
    });
    expect(xml).toContain('<guid>007</guid>');
    expect(xml).toContain('<guid isPermaLink="true"> spaced&amp;odd&lt;guid&gt; </guid>');
  });

  it('leaves out hidden and future episodes and sorts newest first', () => {
    const xml = buildFeed({
      show: show(),
      episodes: [
        episode({ guid: 'old', pubDate: '2026-01-01T00:00:00Z' }),
        episode({ guid: 'new', pubDate: '2026-10-10T00:00:00Z' }),
        episode({ guid: 'hidden', status: 'hidden' }),
        episode({ guid: 'future', pubDate: '2026-12-01T00:00:00Z' }),
      ],
      baseUrl: BASE_URL,
      now: NOW,
    });
    const guids = parseFeedXml(xml).items.map((i) => text(i['guid']));
    expect(guids).toEqual(['new', 'old']);
  });

  it('is deterministic for the same input', () => {
    const input = { show: show(), episodes: [episode()], baseUrl: BASE_URL, now: NOW };
    expect(buildFeed(input)).toBe(buildFeed({ ...input, now: new Date('2026-10-12T00:00:00Z') }));
  });

  it('cannot be broken out of CDATA by show notes', () => {
    const xml = buildFeed({
      show: show(),
      episodes: [episode({ description: 'a ]]> <b>b</b>' })],
      baseUrl: BASE_URL,
      now: NOW,
    });
    expect(validateFeed(xml).ok).toBe(true);
    expect(text(parseFeedXml(xml).items[0]!['description'])).toBe('a ]]> <b>b</b>');
  });
});
