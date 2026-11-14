import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OutletResponse,
  ScheduleEntry,
  ScheduleResponse,
  VideoResponse,
  VideoSummary,
} from '../src/api';
import type { RuntimeConfig } from '../src/auth';
import { createElement, find, installDom, text, type Node } from './dom';

/**
 * A channel's content as the dashboard draws it: Shorts apart from long-form,
 * and anything with a slot badged with the date it goes live. Run against the
 * DOM stand-in, because the thing worth checking is the text a person reads.
 */

const stub = vi.hoisted(() => ({ get: new Map<string, unknown>() }));

vi.mock('../src/api', () => ({
  async get(_config: unknown, path: string) {
    if (!stub.get.has(path)) throw new Error(`No stub for GET ${path}`);
    return stub.get.get(path);
  },
  async post() {
    throw new Error('not used');
  },
}));

const { videoCards, countFormats, countPending, rangeQuery } = await import('../src/ui');
const { slotTime, shortDate } = await import('../src/format');
const { outletView, videoView } = await import('../src/outlets');
const { pendingContent } = await import('../src/schedule');

const config = { apiUrl: 'https://api.example', mediaUrl: 'https://cdn.example' } as RuntimeConfig;
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

/** The cards' own headings, in the order the page would show them. */
const headings = (cards: Node[]) =>
  cards.flatMap((c) => find(c, (n: Node) => n.tag === 'h2').map((h: Node) => h._text));

/** The rows of one card, as text. */
const rows = (card: Node) => find(card, (n: Node) => n.tag === 'tr').map(text);

beforeEach(() => {
  stub.get.clear();
  installDom();
});

describe('videoCards', () => {
  it('splits Shorts from long-form into two cards', () => {
    const cards = videoCards(
      'dr',
      [video(), video({ videoId: 'short-1', title: 'A clip', format: 'short' })],
      90,
      [],
      NOW,
    );
    expect(headings(cards)).toEqual(['Videos', 'Shorts']);
    expect(rows(cards[0]!).join(' ')).toContain('The whole episode');
    expect(rows(cards[0]!).join(' ')).not.toContain('A clip');
    expect(rows(cards[1]!).join(' ')).toContain('A clip');
  });

  it('leaves out a card with nothing in it', () => {
    const cards = videoCards('dr', [video({ format: 'short' })], 90, [], NOW);
    expect(headings(cards)).toEqual(['Shorts']);
  });

  it('badges a scheduled item with the date it goes live, above what is out', () => {
    const cards = videoCards('dr', [video({ format: 'short' })], 90, [entry()], NOW);
    const shorts = cards.find((c: Node) => headings([c])[0] === 'Shorts')!;
    const shown = rows(shorts);
    // Head of the table, under the header row: what is coming, then what is out.
    expect(shown[1]).toContain('Waiting clip');
    expect(shown[1]).toContain('Scheduled');
    expect(shown[1]).toContain(slotTime('2026-11-20T23:00:00Z'));
    expect(shown[2]).toContain('The whole episode');
    expect(find(shorts, (n: Node) => n.className === 'pending')).toHaveLength(1);
  });

  it('files a scheduled video under Videos and a scheduled Short under Shorts', () => {
    const cards = videoCards(
      'dr',
      [],
      90,
      [entry({ kind: 'video', title: 'Long one' }), entry()],
      NOW,
    );
    expect(headings(cards)).toEqual(['Videos', 'Shorts']);
    expect(rows(cards[0]!).join(' ')).toContain('Long one');
    expect(rows(cards[1]!).join(' ')).toContain('Waiting clip');
  });

  it('marks a failed upload rather than showing it as merely scheduled', () => {
    const cards = videoCards(
      'dr',
      [],
      90,
      [entry({ state: 'failed', error: 'quotaExceeded' })],
      NOW,
    );
    const shown = rows(cards[0]!).join(' ');
    expect(shown).toContain('Failed');
    expect(find(cards[0]!, (n: Node) => n.className === 'pending failed')).toHaveLength(1);
  });

  it('badges a recorded video that is uploaded but still waiting, and lists it once', () => {
    const cards = videoCards(
      'dr',
      [video({ videoId: 'abc123', title: 'Up but private', format: 'short' })],
      90,
      [entry({ state: 'scheduled', externalId: 'abc123', title: 'Up but private' })],
      NOW,
    );
    const shown = rows(cards[0]!);
    expect(shown.filter((r) => r.includes('Up but private'))).toHaveLength(1);
    expect(shown[1]).toContain('Scheduled');
    expect(shown[1]).toContain(slotTime('2026-11-20T23:00:00Z'));
  });

  it('badges a video YouTube is holding for a future release, not its upload date', () => {
    // The real shape of a video scheduled in YouTube Studio: uploaded days
    // ago, so `publishedAt` is in the past, and the release time is its own
    // field. Reading the upload date is what showed these as already out.
    const cards = videoCards(
      'dr',
      [
        video({
          videoId: 'Yq1Jz3A6YVE',
          title: 'Bedrock Model Invocation, Sync vs Streaming vs Async',
          format: 'short',
          publishedAt: '2026-11-12T05:00:25Z',
          privacyStatus: 'private',
          scheduledAt: '2026-11-19T14:00:00Z',
          downloads7: 0,
          downloadsTotal: 0,
        }),
      ],
      90,
      [],
      NOW,
    );
    const row = rows(cards[0]!)[1]!;
    expect(row).toContain('Scheduled');
    expect(row).toContain(slotTime('2026-11-19T14:00:00Z'));
    // The upload date is not the release date, so it is not what is shown.
    expect(row).not.toContain(shortDate('2026-11-12T05:00:25Z'));
  });

  it('badges a private video with no release time as private, not scheduled', () => {
    const cards = videoCards(
      'dr',
      [video({ privacyStatus: 'private' }), video({ videoId: 'b', privacyStatus: 'unlisted' })],
      90,
      [],
      NOW,
    );
    const shown = rows(cards[0]!).join(' ');
    expect(shown).toContain('Private');
    expect(shown).toContain('Unlisted');
    expect(shown).not.toContain('Scheduled');
  });

  it('drops the badge once the platform says the video is public', () => {
    const cards = videoCards(
      'dr',
      [video({ privacyStatus: 'public', scheduledAt: undefined })],
      90,
      [],
      NOW,
    );
    expect(rows(cards[0]!).join(' ')).not.toContain('Scheduled');
  });

  it('treats a publish date in the future as scheduled, however it got there', () => {
    // Scheduled in YouTube Studio: no content item, so the date is all there is.
    const cards = videoCards('dr', [video({ publishedAt: '2026-11-25T18:00:00Z' })], 90, [], NOW);
    expect(rows(cards[0]!).join(' ')).toContain('Scheduled');
  });

  it('shows a format tag only where it is not what the card is about', () => {
    const cards = videoCards('dr', [video({ format: 'live', title: 'A stream' })], 90, [], NOW);
    expect(rows(cards[0]!).join(' ')).toContain('Live streams');
    const plain = videoCards('dr', [video()], 90, [], NOW);
    expect(rows(plain[0]!).join(' ')).not.toContain('Long-form');
  });
});

describe('countPending', () => {
  it('counts both what DarkRelay scheduled and what the channel is holding', () => {
    const { count, next } = countPending(
      [
        video(),
        video({ videoId: 'held', privacyStatus: 'private', scheduledAt: '2026-11-19T14:00:00Z' }),
      ],
      [entry({ publishAt: '2026-11-15T23:00:00Z' })],
      NOW,
    );
    expect(count).toBe(2);
    expect(next).toBe('2026-11-15T23:00:00Z');
  });

  it('counts a video with a content item behind it once', () => {
    const { count } = countPending(
      [video({ videoId: 'abc123', privacyStatus: 'private', scheduledAt: '2026-11-19T14:00:00Z' })],
      [entry({ state: 'scheduled', externalId: 'abc123' })],
      NOW,
    );
    expect(count).toBe(1);
  });

  it('counts nothing when everything is out', () => {
    expect(countPending([video()], [], NOW)).toEqual({ count: 0, next: undefined });
  });
});

describe('countFormats', () => {
  it('counts Shorts apart from everything else', () => {
    expect(
      countFormats([
        video(),
        video({ videoId: 'b', format: 'short' }),
        video({ videoId: 'c', format: 'live' }),
      ]),
    ).toEqual({ shorts: 1, long: 2 });
  });
});

describe('pendingContent', () => {
  const schedule = (upcoming: ScheduleEntry[]): ScheduleResponse => ({
    now: NOW.toISOString(),
    brands: [{ brand: 'dr', title: 'Dr. Joanne Skiles', canSchedule: true }],
    upcoming,
    unscheduled: [],
    plans: [],
  });

  it('keeps this brand’s unpublished items, soonest first', async () => {
    stub.get.set(
      '/schedule',
      schedule([
        entry({ id: 'later', publishAt: '2026-11-25T23:00:00Z' }),
        entry({ id: 'soon', publishAt: '2026-11-13T23:00:00Z' }),
        entry({ id: 'other-brand', brand: 'cc' }),
        entry({ id: 'already-out', state: 'published', externalId: 'abc' }),
      ]),
    );
    const pending = await pendingContent(config, 'dr');
    expect(pending.map((e) => e.id)).toEqual(['soon', 'later']);
  });

  it('narrows to one outlet, keeping items recorded before outlets existed', async () => {
    stub.get.set(
      '/schedule',
      schedule([
        entry({ id: 'mine', outlet: 'youtube' }),
        entry({ id: 'theirs', outlet: 'youtube-2' }),
        entry({ id: 'no-outlet', outlet: undefined }),
      ]),
    );
    const pending = await pendingContent(config, 'dr', 'youtube');
    expect(pending.map((e) => e.id).sort()).toEqual(['mine', 'no-outlet']);
  });

  it('costs the badges and nothing else when the schedule route fails', async () => {
    expect(await pendingContent(config, 'dr')).toEqual([]);
  });
});

describe('outletView', () => {
  const outlet = (videos: VideoSummary[]): OutletResponse => ({
    show: 'dr',
    brand: 'dr',
    title: 'Dr. Joanne Skiles',
    outlet: { id: 'youtube', kind: 'youtube', name: 'Dr. Joanne Skiles', source: 'youtube' },
    from: '2026-08-14',
    to: '2026-11-12',
    channel: {
      daily: [],
      totals: {
        views: 0,
        watchSeconds: 0,
        subscribersGained: 0,
        subscribersLost: 0,
        trafficSources: {},
        formats: {},
      },
      subscriberChange: 0,
    },
    content: {
      show: 'dr',
      from: '2026-08-14',
      to: '2026-11-12',
      daily: [],
      totals: {
        downloads: 0,
        serverDownloads: 0,
        apps: {},
        countries: {},
        devices: {},
      },
      sources: [],
      bySource: [],
      byOutlet: [],
    },
    videos,
  });

  it('draws the channel page with both sections and the schedule badges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const app = createElement('main');
    // The page builds its range from today, so the stub key is built the same way.
    stub.get.set(
      `/brands/dr/outlets/youtube?${rangeQuery(90)}`,
      outlet([video(), video({ videoId: 'short-1', title: 'A clip', format: 'short' })]),
    );
    stub.get.set('/schedule', {
      now: NOW.toISOString(),
      brands: [{ brand: 'dr', title: 'Dr. Joanne Skiles', canSchedule: true }],
      upcoming: [entry()],
      unscheduled: [],
      plans: [],
    } satisfies ScheduleResponse);
    await outletView(app, config, 'dr', 'youtube', 90);
    const shown = text(app);
    expect(shown).toContain('Videos');
    expect(shown).toContain('Shorts');
    expect(shown).toContain('The whole episode');
    expect(shown).toContain('A clip');
    expect(shown).toContain('Waiting clip');
    expect(shown).toContain('Scheduled');
    vi.useRealTimers();
  });
});

describe('videoView', () => {
  const response = (over: Partial<VideoSummary>): VideoResponse => ({
    show: 'dr',
    brand: 'dr',
    from: '2026-11-05',
    to: '2026-11-12',
    daily: [],
    totals: { downloads: 0, serverDownloads: 0, apps: {}, countries: {}, devices: {} },
    sources: [],
    bySource: [],
    byOutlet: [],
    video: video({ videoId: 'v1', ...over }),
  });

  const draw = async (over: Partial<VideoSummary>) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const app = createElement('main');
    stub.get.set(`/brands/dr/videos/v1?${rangeQuery(7)}`, response(over));
    await videoView(app, config, 'dr', 'v1', 7);
    vi.useRealTimers();
    return text(app);
  };

  it('says a video YouTube is holding is scheduled, with the date it goes live', async () => {
    // The upload date is days before the release, and is not "published".
    const shown = await draw({
      title: 'IAM Least Privilege in Practice',
      publishedAt: '2026-11-14T03:07:26Z',
      scheduledAt: '2026-11-18T05:00:00Z',
      privacyStatus: 'private',
    });
    expect(shown).toContain(`Scheduled · ${slotTime('2026-11-18T05:00:00Z')}`);
    expect(shown).not.toContain('published');
    expect(shown).not.toContain(shortDate('2026-11-14T03:07:26Z'));
  });

  it('says private, not scheduled, where there is no release time', async () => {
    const shown = await draw({ privacyStatus: 'private', scheduledAt: undefined });
    expect(shown).toContain('Private');
    expect(shown).not.toContain('published');
  });

  it('keeps the publish date for a video that is out', async () => {
    const shown = await draw({ privacyStatus: 'public' });
    expect(shown).toContain(`published ${shortDate('2026-10-01T14:00:00Z')}`);
    expect(shown).not.toContain('Scheduled');
  });
});
