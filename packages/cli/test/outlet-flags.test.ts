import { describe, expect, it } from 'vitest';
import { buildOutlet } from '../src/commands/brand';

const now = new Date('2026-11-12T10:00:00Z');

describe('outlet flags', () => {
  it.each([
    ['rss', 'connection', '--connection'],
    ['spotify', 'connection', '--connection'],
    ['apple', 'connection', '--connection'],
    ['youtube', 'feed', '--feed'],
    ['spotify', 'feed', '--feed'],
    ['apple', 'feed', '--feed'],
    ['rss', 'url', '--url'],
    ['youtube', 'url', '--url'],
  ])('rejects %s outlets with %s', (kind, flag, option) => {
    expect(() =>
      buildOutlet(
        'brand',
        { kind, ...(kind === 'youtube' ? { connection: 'channel' } : {}), [flag]: 'value' },
        now,
      ),
    ).toThrow(`${kind} outlets do not accept ${option}`);
  });

  it.each([
    { kind: 'rss', feed: 'other-feed', expected: { show: 'other-feed' } },
    {
      kind: 'youtube',
      connection: 'channel',
      channelId: 'UC123',
      expected: { connection: 'channel', channelId: 'UC123' },
    },
    {
      kind: 'spotify',
      url: 'https://open.spotify.com/show/x',
      expected: { url: 'https://open.spotify.com/show/x' },
    },
    {
      kind: 'apple',
      url: 'https://podcasts.apple.com/podcast/x',
      expected: { url: 'https://podcasts.apple.com/podcast/x' },
    },
  ])('keeps valid $kind flags, id and label', ({ expected, ...flags }) => {
    expect(buildOutlet('brand', { ...flags, id: 'custom', label: 'Main' }, now)).toEqual({
      kind: flags.kind,
      id: 'custom',
      label: 'Main',
      addedAt: now.toISOString(),
      ...expected,
    });
  });
});
