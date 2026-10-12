import { describe, expect, it } from 'vitest';
import { chapterLines, formatTimestamp, htmlToText, youtubeMetadata } from '../src';

describe('htmlToText', () => {
  it('keeps paragraphs, list items and links, and decodes entities', () => {
    expect(
      htmlToText(
        '<p>Hello &amp; welcome.</p><ul><li>One</li><li>Two</li></ul><p>See <a href="https://x.com">x.com site</a><br>Bye&nbsp;now</p>',
      ),
    ).toBe('Hello & welcome.\n\n• One\n• Two\n\nSee x.com site (https://x.com)\nBye now');
  });
  it('does not repeat a link whose text is its URL', () => {
    expect(htmlToText('<a href="https://x.com">https://x.com</a>')).toBe('https://x.com');
  });
});

describe('chapterLines', () => {
  it('formats chapters YouTube will accept', () => {
    expect(
      chapterLines([
        { startTime: 0, title: 'Intro' },
        { startTime: 75, title: 'Main' },
        { startTime: 3725, title: 'Outro' },
      ]),
    ).toBe('0:00 Intro\n1:15 Main\n1:02:05 Outro');
  });
  it('returns nothing when YouTube would ignore them', () => {
    expect(
      chapterLines([
        { startTime: 0, title: 'a' },
        { startTime: 30, title: 'b' },
      ]),
    ).toBeUndefined();
    expect(
      chapterLines([
        { startTime: 5, title: 'a' },
        { startTime: 30, title: 'b' },
        { startTime: 60, title: 'c' },
      ]),
    ).toBeUndefined();
    expect(
      chapterLines([
        { startTime: 0, title: 'a' },
        { startTime: 5, title: 'b' },
        { startTime: 60, title: 'c' },
      ]),
    ).toBeUndefined();
  });
  it('formats timestamps', () => {
    expect(formatTimestamp(59.9)).toBe('0:59');
    expect(formatTimestamp(3600)).toBe('1:00:00');
  });
});

describe('youtubeMetadata', () => {
  it('meets YouTube limits: no angle brackets, title 100 chars, description 5000 bytes, tags 500 chars', () => {
    const m = youtubeMetadata({
      title: 'Leadership &amp; <Real> Stories ' + 'x'.repeat(200),
      descriptionHtml: '<p>' + 'é'.repeat(4000) + '</p>',
      tags: ['a b', 'a b', 'c,d', ...Array.from({ length: 200 }, (_, i) => `tag${i}`)],
    });
    expect(m.title.startsWith('Leadership & ‹Real› Stories')).toBe(true);
    expect(m.title.length).toBe(100);
    expect(new TextEncoder().encode(m.description).length).toBeLessThanOrEqual(5000);
    expect(m.description.endsWith('...')).toBe(true);
    expect(m.tags.slice(0, 3)).toEqual(['a b', 'cd', 'tag0']);
    const cost = m.tags.reduce(
      (n, t, i) => n + t.length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0),
      0,
    );
    expect(cost).toBeLessThanOrEqual(500);
  });
  it('appends chapters and the footer', () => {
    const m = youtubeMetadata({
      title: 't',
      descriptionHtml: '<p>Notes</p>',
      chapters: [
        { startTime: 0, title: 'A' },
        { startTime: 20, title: 'B' },
        { startTime: 40, title: 'C' },
      ],
      footer: 'Listen: https://media.example.com',
      tags: [],
    });
    expect(m.description).toBe(
      'Notes\n\nChapters\n0:00 A\n0:20 B\n0:40 C\n\nListen: https://media.example.com',
    );
  });
});
