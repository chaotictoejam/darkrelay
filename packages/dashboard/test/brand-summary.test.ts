import { beforeEach, describe, expect, it } from 'vitest';
import type { ScheduleEntry, ShowResponse, VideoSummary } from '../src/api';
import { countScheduled, outletRows, outletsSummary, scheduledCard, trend } from '../src/ui';
import { slotTime } from '../src/format';
import { find, installDom, text, type Node } from './dom';

/**
 * The brand page as a summary: three boxes a person can read in a glance —
 * the overall numbers, what is genuinely coming, and where this brand
 * publishes, with YouTube and the podcast told apart by name.
 */

const NOW = new Date('2026-11-12T15:00:00Z');

const video = (over: Partial<VideoSummary> = {}): VideoSummary => ({
  videoId: 'long-1',
  title: 'The whole episode',
  publishedAt: '2026-10-01T14:00:00Z',
  format: 'long',
  downloads7: 120,
  downloadsTotal: 400,
  ...over,
});

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  brand: 'dr',
  brandTitle: 'Dr. Joanne Skiles',
  id: 'clip-1',
  title: 'Waiting clip',
  kind: 'short',
  publishAt: '2026-11-20T23:00:00Z',
  outlet: 'youtube',
  state: 'planned',
  ...over,
});

const show = (over: Partial<ShowResponse> = {}): ShowResponse =>
  ({
    show: 'dr',
    title: 'Dr. Joanne Skiles',
    from: '2026-08-14',
    to: '2026-11-12',
    daily: [],
    totals: { downloads: 0, serverDownloads: 0, apps: {}, countries: {}, devices: {} },
    sources: [],
    bySource: [],
    byOutlet: [],
    outlets: [],
    episodes: [],
    videos: [],
    ...over,
  }) as ShowResponse;

beforeEach(() => installDom());

describe('outletRows', () => {
  it('keeps an outlet with no plays in the range', () => {
    const rows = outletRows(
      show({
        outlets: [
          { id: 'feed', kind: 'rss', name: 'My Show feed', source: 'cloudfront' },
          { id: 'youtube', kind: 'youtube', name: 'My Show on YouTube', source: 'youtube' },
        ],
        byOutlet: [
          {
            id: 'feed',
            kind: 'rss',
            name: 'My Show feed',
            source: 'cloudfront',
            plays: 5980,
            watchSeconds: 0,
            apps: {},
          },
        ],
      }),
    );
    expect(rows.map((r) => [r.id, r.plays])).toEqual([
      ['feed', 5980],
      ['youtube', 0],
    ]);
  });

  it('keeps an outlet the brand row no longer names, so no number goes missing', () => {
    const rows = outletRows(
      show({
        outlets: [],
        byOutlet: [
          {
            id: 'spotify',
            kind: 'spotify',
            name: 'Spotify',
            source: 'spotify-csv',
            plays: 515,
            watchSeconds: 0,
            apps: {},
          },
        ],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(['spotify']);
  });
});

describe('outletsSummary', () => {
  const data = show({
    outlets: [
      { id: 'feed', kind: 'rss', name: 'My Show feed', source: 'cloudfront' },
      { id: 'youtube', kind: 'youtube', name: 'My Show on YouTube', source: 'youtube' },
    ],
    byOutlet: [
      {
        id: 'feed',
        kind: 'rss',
        name: 'My Show feed',
        source: 'cloudfront',
        plays: 5980,
        watchSeconds: 0,
        apps: {},
      },
      {
        id: 'youtube',
        kind: 'youtube',
        name: 'My Show on YouTube',
        source: 'youtube',
        plays: 3992,
        watchSeconds: 486_000,
        apps: {},
      },
    ],
    episodes: [
      {
        show: 'dr',
        episodeId: 'e1',
        title: 'Episode 42',
        pubDate: '2026-11-11T00:00:00Z',
        downloads7: 168,
        downloads30: 168,
        downloads90: 168,
        downloadsTotal: 168,
        serverTotal: 0,
      },
    ],
    videos: [video(), video({ videoId: 'short-1', title: 'A clip', format: 'short' })],
  });

  it('labels each outlet as YouTube or Podcast, not by its name alone', () => {
    const shown = text(outletsSummary(data, 'dr', 90) as unknown as Node);
    expect(shown).toContain('YouTube');
    expect(shown).toContain('Podcast');
    expect(shown).toContain('My Show feed');
    expect(shown).toContain('My Show on YouTube');
  });

  it('counts a play in the words that outlet uses', () => {
    const shown = text(outletsSummary(data, 'dr', 90) as unknown as Node);
    expect(shown).toContain('views, last 90 days');
    expect(shown).toContain('downloads, last 90 days');
  });

  it('says what is on each outlet, and links a channel to its own page', () => {
    const box = outletsSummary(data, 'dr', 90) as unknown as Node;
    const shown = text(box);
    expect(shown).toContain('1 video · 1 Short');
    expect(shown).toContain('1 episode');
    const links = find(box, (n: Node) => n.tag === 'a').map((a: Node) => a.href);
    expect(links).toContain('#/s/dr/o/youtube?days=90');
  });

  it('says so plainly when a brand has no outlets yet', () => {
    expect(text(outletsSummary(show(), 'dr', 90) as unknown as Node)).toContain(
      'No outlets recorded yet',
    );
  });
});

describe('trend', () => {
  it('ends the line on the last counted day, not on a day with no row', () => {
    const box = trend(
      show({
        from: '2026-11-10',
        to: '2026-11-14',
        daily: [
          { date: '2026-11-10', downloads: 120, serverDownloads: 0 },
          { date: '2026-11-12', downloads: 140, serverDownloads: 0 },
          { date: '2026-11-13', downloads: 100, serverDownloads: 0 },
        ],
      }),
    ) as unknown as Node;
    const dates = find(box, (n: Node) => n.tag === 'tr')
      .map(text)
      .filter((r: string) => r.includes('2026-'));
    expect(dates.at(-1)).toContain('2026-11-13');
    expect(dates.join(' ')).not.toContain('2026-11-14');
    // A day in the middle with nothing recorded is still a zero: that one is
    // a real quiet day, not a day nobody has counted.
    expect(dates.join(' ')).toContain('2026-11-11');
  });
});

describe('scheduledCard', () => {
  it('leads with the count and the next slot, and lists what is coming', () => {
    const summary = countScheduled(
      [],
      [
        entry({ id: 'soon', title: 'Soon', publishAt: '2026-11-13T23:00:00Z' }),
        entry({ id: 'later', title: 'Later', publishAt: '2026-11-25T23:00:00Z' }),
      ],
      NOW,
    );
    const shown = text(scheduledCard(summary) as unknown as Node);
    expect(shown).toContain('Scheduled');
    expect(shown).toContain('2');
    expect(shown).toContain(`next ${slotTime('2026-11-13T23:00:00Z')}`);
    expect(shown).toContain('Soon');
    expect(shown).toContain('Later');
  });

  it('counts only what is ahead, and says what the rest is', () => {
    const summary = countScheduled(
      [video({ videoId: 'p', privacyStatus: 'unlisted' })],
      [
        entry({ id: 'past', publishAt: '2026-11-10T23:00:00Z', state: 'scheduled' }),
        entry({ id: 'no-slot', publishAt: undefined }),
        entry({ id: 'broken', state: 'failed', error: 'quotaExceeded' }),
      ],
      NOW,
    );
    const shown = text(scheduledCard(summary) as unknown as Node);
    expect(summary.count).toBe(0);
    expect(shown).toContain('nothing with a time ahead of it');
    expect(shown).toContain('1 waiting for a slot');
    expect(shown).toContain('1 past its slot and still not public');
    expect(shown).toContain('1 private or unlisted, with no release time');
    expect(shown).toContain('1 failed to upload');
  });

  it('shows the first few and says how many more there are', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      entry({ id: `c${i}`, title: `Clip ${i}`, publishAt: `2026-11-2${i % 10}T23:00:00Z` }),
    );
    const shown = text(scheduledCard(countScheduled([], many, NOW)) as unknown as Node);
    expect(shown).toContain('and 3 more');
  });
});
