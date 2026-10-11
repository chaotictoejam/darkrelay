import { describe, expect, it } from 'vitest';
import { podcastGuidFromFeedUrl, uuidV5 } from '../src';

describe('uuidV5', () => {
  it('matches the RFC 4122 reference output', () => {
    expect(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });
});

describe('podcastGuidFromFeedUrl', () => {
  it('matches the Podcasting 2.0 spec example', () => {
    expect(podcastGuidFromFeedUrl('https://mp3s.nashownotes.com/pc20rss.xml')).toBe(
      '917393e3-1b1e-5cef-ace4-edaa54e1f810',
    );
  });

  it('ignores scheme and trailing slashes', () => {
    const a = podcastGuidFromFeedUrl('https://anchor.fm/s/1117b1134/podcast/rss');
    expect(podcastGuidFromFeedUrl('http://anchor.fm/s/1117b1134/podcast/rss/')).toBe(a);
    expect(a).toBe('23f35153-ba05-5a2c-9d23-8c51b427723c');
  });
});
