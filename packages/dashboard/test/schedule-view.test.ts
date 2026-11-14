import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/auth';
import type { SchedulePlan, ScheduleResponse, SlotScore, SlotScoresResponse } from '../src/api';
import { createElement, find, text, type Node } from './dom';

/**
 * The schedule pages, actually run. The rest of the dashboard tests only
 * cover pure helpers, which cannot catch a page that throws on render — so
 * these build both views against a small DOM stand-in and read back the text
 * a person would see.
 */

const stub = vi.hoisted(() => ({
  get: new Map<string, unknown>(),
  post: new Map<string, unknown>(),
  posted: [] as { path: string; body: unknown }[],
}));

vi.mock('../src/api', () => ({
  async get(_config: unknown, path: string) {
    if (!stub.get.has(path)) throw new Error(`No stub for GET ${path}`);
    return stub.get.get(path);
  },
  async post(_config: unknown, path: string, body: unknown) {
    stub.posted.push({ path, body });
    return stub.post.get(path) ?? {};
  },
}));

const { calendarView, slotsView } = await import('../src/schedule');

const config = { apiUrl: 'https://api.example', mediaUrl: 'https://cdn.example' } as RuntimeConfig;

let app: Node;

const schedule = (over: Partial<ScheduleResponse> = {}): ScheduleResponse => ({
  now: '2026-11-12T15:00:00Z',
  brands: [{ brand: 'cc', title: 'Chaotic Commits', canSchedule: true }],
  upcoming: [],
  unscheduled: [],
  plans: [],
  ...over,
});

function slotScores(over: Partial<SlotScoresResponse> = {}): SlotScoresResponse {
  const slots: SlotScore[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const tested = day === 6 && hour === 18;
      slots.push({
        day,
        hour,
        key: `${day}-${hour}`,
        score: tested ? 1.74 : 0.5,
        samples: tested ? 4 : 0,
        prior: 0.5,
        basis: tested ? 'history' : 'prior',
        ...(tested ? { views: 3000 } : {}),
      });
    }
  }
  return { zone: 'America/New_York', samples: 4, slots, ...over };
}

const plan = (over: Partial<SchedulePlan> = {}): SchedulePlan => ({
  planId: '20261112103000-7f3a21',
  brand: 'cc',
  outlet: 'youtube',
  zone: 'America/New_York',
  createdAt: '2026-11-12T10:30:00Z',
  from: '2026-11-15T10:00:00Z',
  to: '2026-12-06T05:00:00Z',
  perWeek: 2,
  minGapHours: 20,
  exploreShare: 0.2,
  samples: 9,
  assignments: [
    {
      id: 'bus-factor-1',
      title: 'Bus factor, part one',
      kind: 'short',
      publishAt: '2026-11-21T23:00:00Z',
      slot: '6-18',
      slotLabel: 'Sat 18:00',
      score: 1.74,
      basis: 'history',
      explore: false,
      reason: '4 past videos here averaged 1.74x a typical slot',
    },
  ],
  unplaced: [],
  untouched: [],
  warnings: [],
  applied: [],
  ...over,
});

beforeEach(() => {
  stub.get.clear();
  stub.post.clear();
  stub.posted.length = 0;
  (globalThis as { document?: unknown }).document = { createElement };
  app = createElement('main');
});

describe('calendarView', () => {
  it('shows what is coming up, grouped by day, with each item’s state', async () => {
    stub.get.set(
      '/schedule',
      schedule({
        upcoming: [
          {
            brand: 'cc',
            brandTitle: 'Chaotic Commits',
            id: 'clip-1',
            title: 'Bus factor clip',
            kind: 'short',
            publishAt: '2026-11-13T23:00:00Z',
            outlet: 'youtube',
            state: 'scheduled',
            externalId: 'abc123',
          },
          {
            brand: 'dr',
            brandTitle: 'Dr. Joanne Skiles',
            id: 'clip-2',
            title: 'Tutorial clip',
            kind: 'short',
            publishAt: '2026-11-20T23:00:00Z',
            state: 'planned',
          },
        ],
      }),
    );
    await calendarView(app, config);
    const shown = text(app);
    expect(shown).toContain('Schedule');
    expect(shown).toContain('Bus factor clip');
    expect(shown).toContain('Tomorrow');
    expect(shown).toContain('uploaded, waiting for its time');
    expect(shown).toContain('Tutorial clip');
    expect(shown).toContain('not uploaded yet');
    // A published item links out to the video itself.
    const links = find(app, (n) => n.tag === 'a' && String(n.href ?? '').includes('youtu.be'));
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('https://youtu.be/abc123');
  });

  it('says it does not cover episode releases, so the calendar cannot mislead', async () => {
    stub.get.set('/schedule', schedule());
    await calendarView(app, config);
    expect(text(app)).toContain('Episode releases are kept by their feed');
  });

  it('shows a failure and its reason rather than a quiet gap', async () => {
    stub.get.set(
      '/schedule',
      schedule({
        upcoming: [
          {
            brand: 'cc',
            brandTitle: 'Chaotic Commits',
            id: 'clip-1',
            title: 'Broken clip',
            kind: 'short',
            publishAt: '2026-11-13T23:00:00Z',
            state: 'failed',
            error: 'quotaExceeded',
            warnings: ['Thumbnail: needs a verified channel'],
          },
        ],
      }),
    );
    await calendarView(app, config);
    const shown = text(app);
    expect(shown).toContain('failed: quotaExceeded');
    expect(shown).toContain('Thumbnail: needs a verified channel');
    expect(shown).toContain('Failed');
    expect(find(app, (n) => n.className === 'entry failed')).toHaveLength(1);
  });

  it('separates what has no slot, and offers to plan it', async () => {
    stub.get.set(
      '/schedule',
      schedule({
        unscheduled: [
          {
            brand: 'cc',
            brandTitle: 'Chaotic Commits',
            id: 'clip-9',
            title: 'Waiting clip',
            kind: 'short',
          },
        ],
      }),
    );
    await calendarView(app, config);
    const shown = text(app);
    expect(shown).toContain('No slot yet');
    expect(shown).toContain('Waiting clip');
    expect(shown).toContain('Nothing is ever uploaded without a slot');
    expect(find(app, (n) => n.href === '#/s/cc/slots')).not.toHaveLength(0);
  });

  it('offers a plan that is waiting, with a link to review it', async () => {
    stub.get.set(
      '/schedule',
      schedule({
        plans: [
          {
            brand: 'cc',
            planId: '20261112103000-7f3a21',
            createdAt: '2026-11-12T10:30:00Z',
            items: 5,
            from: '2026-11-15T10:00:00Z',
            to: '2026-12-06T05:00:00Z',
          },
        ],
      }),
    );
    await calendarView(app, config);
    expect(text(app)).toContain('A plan is waiting');
    expect(text(app)).toContain('5 items proposed for cc');
    expect(find(app, (n) => n.href === '#/s/cc/slots?plan=20261112103000-7f3a21')).not.toHaveLength(
      0,
    );
  });

  it('says so plainly when there is nothing scheduled', async () => {
    stub.get.set('/schedule', schedule());
    await calendarView(app, config);
    expect(text(app)).toContain('Nothing is scheduled');
  });
});

describe('slotsView', () => {
  it('draws the week and explains what the shading rests on', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', { brand: 'cc', plans: [] });
    await slotsView(app, config, 'cc');

    const cells = find(app, (n) => String(n.className ?? '').startsWith('heat-cell'));
    expect(cells).toHaveLength(168);
    // Only the slot with history is shaded; the rest are honestly blank.
    expect(cells.filter((c: Node) => c.className === 'heat-cell empty')).toHaveLength(167);
    const tested = cells.find((c: Node) => c.className !== 'heat-cell empty');
    expect(tested.attrs['aria-label']).toContain('Sat 18:00');
    expect(tested.attrs['aria-label']).toContain('1.74x a typical slot');
    expect(text(app)).toContain('Scored on 4 past videos');
  });

  it('admits when every slot is just the prior', async () => {
    stub.get.set('/schedule/cc/slots', slotScores({ samples: 0 }));
    stub.get.set('/schedule/cc/plans', { brand: 'cc', plans: [] });
    await slotsView(app, config, 'cc');
    expect(text(app)).toContain('No settled history for this brand yet');
  });

  it('warns when Shorts had to be scored against long-form', async () => {
    stub.get.set('/schedule/cc/slots', slotScores({ fellBackToAllFormats: true }));
    stub.get.set('/schedule/cc/plans', { brand: 'cc', plans: [] });
    await slotsView(app, config, 'cc');
    expect(text(app)).toContain('Too few Shorts to score on their own');
  });

  it('shows a proposed plan with its reasons, and an approve button', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', { brand: 'cc', plans: [plan()] });
    await slotsView(app, config, 'cc');
    const shown = text(app);
    expect(shown).toContain('Proposed plan');
    expect(shown).toContain('Bus factor, part one');
    expect(shown).toContain('Sat 18:00');
    expect(shown).toContain('4 past videos here averaged 1.74x a typical slot');
    expect(shown).toContain('Nothing is scheduled until you approve it');
    expect(shown).toContain('Nothing uploads now');
    expect(find(app, (n) => n._text === 'Approve this plan')).toHaveLength(1);
  });

  it('offers no approve button for a plan already taken', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', {
      brand: 'cc',
      plans: [plan({ approvedAt: '2026-11-12T11:00:00Z' })],
    });
    await slotsView(app, config, 'cc');
    expect(find(app, (n) => n._text === 'Approve this plan')).toHaveLength(0);
    expect(text(app)).toContain('Approved');
  });

  it('carries a plan’s warnings and anything it could not place', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', {
      brand: 'cc',
      plans: [
        plan({
          warnings: ['10 items need a slot but the window holds 3.'],
          unplaced: [{ id: 'clip-x', title: 'Late clip', reason: 'the window ran out of slots' }],
        }),
      ],
    });
    await slotsView(app, config, 'cc');
    const shown = text(app);
    expect(shown).toContain('10 items need a slot but the window holds 3.');
    expect(shown).toContain('Late clip: the window ran out of slots');
  });

  it('plans only unslotted content by default', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', { brand: 'cc', plans: [] });
    stub.post.set('/schedule/cc/plans', plan());
    await slotsView(app, config, 'cc');
    expect(text(app)).toContain('everything with no slot yet');
    find(app, (n: Node) => n._text === 'Propose a plan')[0]!.handlers.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stub.posted).toEqual([
      {
        path: '/schedule/cc/plans',
        body: { replan: undefined, weeks: undefined, perWeek: undefined },
      },
    ]);
  });

  /** The case for a brand whose Shorts are already scheduled and uploaded. */
  it('asks for a replan, and says what that means for uploaded clips', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', { brand: 'cc', plans: [] });
    stub.post.set('/schedule/cc/plans', plan());
    await slotsView(app, config, 'cc');
    const box = find(app, (n: Node) => n.tag === 'input' && n.type === 'checkbox')[0]!;
    box.checked = true;
    box.handlers.change();
    const shown = text(app);
    expect(shown).toContain('settled slots included');
    expect(shown).toContain('release time moved there, and is not uploaded again');

    const weeks = find(app, (n: Node) => n.tag === 'input' && n.type === 'number');
    weeks[0]!.value = '4';
    weeks[1]!.value = '2';
    find(app, (n: Node) => n._text === 'Propose a plan')[0]!.handlers.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stub.posted[0]!.body).toEqual({ replan: true, weeks: 4, perWeek: 2 });
  });

  it('shows the plan the url asks for, not merely the newest', async () => {
    stub.get.set('/schedule/cc/slots', slotScores());
    stub.get.set('/schedule/cc/plans', {
      brand: 'cc',
      plans: [plan({ planId: 'newest', assignments: [] }), plan({ planId: 'asked-for' })],
    });
    await slotsView(app, config, 'cc', 'asked-for');
    expect(text(app)).toContain('Bus factor, part one');
    expect(text(app)).toContain('Earlier plans');
  });
});
