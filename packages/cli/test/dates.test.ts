import { EpisodeManifest } from '@darkrelay/core';
import { describe, expect, it } from 'vitest';
import { describeTime, episodeState, parsePubDate } from '../src/dates';

const NOW = new Date('2026-10-12T12:00:00Z');

describe('parsePubDate', () => {
  it('reads a local date and time in the machine time zone', () => {
    expect(parsePubDate('2026-10-20 09:00', NOW).toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(parsePubDate('2026-10-20T09:00:30', NOW).toISOString()).toBe('2026-10-20T13:00:30.000Z');
  });

  it('honours an explicit zone', () => {
    expect(parsePubDate('2026-10-20T09:00Z', NOW).toISOString()).toBe('2026-10-20T09:00:00.000Z');
    expect(parsePubDate('2026-10-20T09:00:00-07:00', NOW).toISOString()).toBe(
      '2026-10-20T16:00:00.000Z',
    );
  });

  it('accepts "now"', () => {
    expect(parsePubDate('now', NOW)).toBe(NOW);
  });

  it('handles the DST change: 09:00 local in November is 14:00 UTC', () => {
    expect(parsePubDate('2026-11-02 09:00', NOW).toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('refuses a bare date instead of silently using UTC midnight', () => {
    expect(() => parsePubDate('2026-10-20', NOW)).toThrow(/Add a time/);
  });

  it('refuses impossible dates and junk', () => {
    expect(() => parsePubDate('2026-02-30 09:00', NOW)).toThrow(/No such date/);
    expect(() => parsePubDate('next tuesday', NOW)).toThrow(/Can't read/);
  });
});

describe('episodeState', () => {
  const ep = (pubDate: string, status: 'published' | 'hidden' = 'published') =>
    EpisodeManifest.parse({
      schemaVersion: 1,
      guid: 'g',
      title: 't',
      description: '',
      pubDate,
      status,
      enclosure: { asset: { key: 'a' }, length: 1, type: 'audio/mpeg' },
      updatedAt: pubDate,
    });
  it('classifies live, scheduled and hidden', () => {
    expect(episodeState(ep('2026-10-12T11:59:59Z'), NOW)).toBe('live');
    expect(episodeState(ep('2026-10-12T12:00:01Z'), NOW)).toBe('scheduled');
    expect(episodeState(ep('2026-10-20T00:00:00Z', 'hidden'), NOW)).toBe('hidden');
  });
});

describe('describeTime', () => {
  it('shows local time with its zone, and UTC', () => {
    expect(describeTime('2026-10-16T04:00:00.000Z')).toMatch(
      /^Oct 16, 2026, 12:00 AM [A-Z]+[+\d:]* \(2026-10-16 04:00 UTC\)$/,
    );
  });
});
