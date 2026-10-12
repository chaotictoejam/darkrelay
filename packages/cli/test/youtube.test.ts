import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { matchByTitle, normalizeTitle, parseVideoId, pkce } from '../src/commands/youtube';

describe('matchByTitle', () => {
  const uploads = [
    {
      videoId: 'aaaaaaaaaaa',
      title: 'From Scared to Published: Why Your Story is Your Superpower',
    },
    { videoId: 'bbbbbbbbbbb', title: 'debug: your codebase is haunted' },
    { videoId: 'ccccccccccc', title: 'Trailer' },
    { videoId: 'ddddddddddd', title: 'Trailer' },
  ];
  it('matches by normalized title and skips linked episodes and ambiguous titles', () => {
    const r = matchByTitle(
      [
        { guid: 'g1', title: 'From Scared to Published: Why Your Story is Your Superpower' },
        { guid: 'g2', title: 'Debug: Your Codebase Is Haunted!' },
        { guid: 'g3', title: 'Trailer' },
        {
          guid: 'g4',
          title: 'Already linked',
          youtube: { videoId: 'zzzzzzzzzzz', linkedAt: '2026-10-01T00:00:00Z' },
        },
        { guid: 'g5', title: 'Not on YouTube' },
      ],
      uploads,
    );
    expect(r.matches.map((m) => [m.guid, m.videoId])).toEqual([
      ['g1', 'aaaaaaaaaaa'],
      ['g2', 'bbbbbbbbbbb'],
    ]);
    expect(r.unmatched).toEqual(['Trailer', 'Not on YouTube']);
  });

  it('treats &amp; and & alike (Spotify titles often carry a literal &amp;)', () => {
    expect(normalizeTitle('Leadership &amp; Real Stories')).toBe(
      normalizeTitle('Leadership & Real Stories'),
    );
  });
});

describe('parseVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('%s', (input, id) => expect(parseVideoId(input)).toBe(id));
  it('rejects anything else', () => expect(() => parseVideoId('nope')).toThrow());
});

describe('pkce', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = pkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});
