import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { matchUploads, normalizeTitle, parseVideoId, pkce } from '../src/commands/youtube';

describe('matchUploads', () => {
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
    const r = matchUploads(
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

  it('falls back to the episode title named in a video description', () => {
    const r = matchUploads(
      [
        { guid: 'g1', title: 'Git Basics' },
        { guid: 'g2', title: 'Git Basics Part 2' },
        { guid: 'g3', title: 'Episode 1' },
        { guid: 'g4', title: 'Rebase & Chill' },
      ],
      [
        {
          videoId: 'aaaaaaaaaaa',
          title: 'You NEED to learn git',
          description: 'Git Basics\n\nIn this episode...',
        },
        {
          videoId: 'bbbbbbbbbbb',
          title: 'Git, part two!',
          description: 'Chaotic Commits: Git Basics Part 2',
        },
        { videoId: 'ccccccccccc', title: 'Short', description: 'From Episode 12 of the podcast' },
        {
          videoId: 'ddddddddddd',
          title: 'Rebasing 101',
          description: 'Rebase &amp; Chill. Also see: Episode 1',
        },
      ],
    );
    expect(r.matches.map((m) => [m.guid, m.videoId, m.by])).toEqual([
      ['g1', 'aaaaaaaaaaa', 'description'],
      ['g2', 'bbbbbbbbbbb', 'description'],
    ]);
    // ddd names two episodes, so neither is linked; "Episode 1" isn't inside "Episode 12".
    expect(r.unmatched).toEqual(['Episode 1', 'Rebase & Chill']);
  });

  it('prefers an identical title over a description mention', () => {
    const r = matchUploads(
      [{ guid: 'g1', title: 'Merge Conflicts' }],
      [
        { videoId: 'aaaaaaaaaaa', title: 'Recap', description: 'Last week: Merge Conflicts' },
        { videoId: 'bbbbbbbbbbb', title: 'Merge Conflicts', description: '' },
      ],
    );
    expect(r.matches).toEqual([
      { guid: 'g1', title: 'Merge Conflicts', videoId: 'bbbbbbbbbbb', by: 'title' },
    ]);
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
