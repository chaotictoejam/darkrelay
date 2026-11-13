import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPLORE_SHARE,
  DEFAULT_ZONE,
  buildPlan,
  chooseSlots,
  scoreSlots,
  slotOf,
  type PlanItem,
  type PlanOptions,
  type SlotSample,
} from '../src';

const NOW = new Date('2026-11-12T10:00:00Z');
/** Three days on from NOW: the planner never schedules inside the upload lead. */
const FROM = new Date('2026-11-15T10:00:00Z');

const SATURDAYS = ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24'];
const MIDWEEK = ['2026-10-06', '2026-10-07', '2026-10-13', '2026-10-14'];
const at18 = (date: string) => `${date}T22:00:00Z`;
const at13 = (date: string) => `${date}T17:00:00Z`;

function sample(at: string, views72h: number, id: string): SlotSample {
  return {
    id,
    publishedAt: new Date(at).toISOString(),
    format: 'short',
    views72h,
    watchSeconds72h: views72h * 15,
    durationSeconds: 30,
  };
}

/** A brand that does well on Saturday evenings and averagely midweek. */
const history = [
  ...MIDWEEK.map((d) => sample(at13(d), 1000, `base-${d}`)),
  ...SATURDAYS.map((d) => sample(at18(d), 3000, `sat-${d}`)),
];
const scores = scoreSlots(history, { now: NOW });
const blank = scoreSlots([], { now: NOW });

const items = (n: number, over: Partial<PlanItem> = {}): PlanItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `clip-${String(i + 1).padStart(2, '0')}`,
    title: `Clip ${i + 1}`,
    kind: 'short' as const,
    ...over,
  }));

const options = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  planId: 'plan-1',
  brand: 'cc',
  outlet: 'youtube',
  zone: DEFAULT_ZONE,
  from: FROM,
  now: NOW,
  ...over,
});

describe('chooseSlots', () => {
  it('takes the number asked for each week, and none before the window opens', () => {
    const chosen = chooseSlots(scores, { from: FROM, weeks: 3, perWeek: 2 });
    expect(chosen).toHaveLength(6);
    expect(chosen.every((c) => c.at.getTime() > FROM.getTime())).toBe(true);
    // Sorted in time, which is what a plan is read in.
    const times = chosen.map((c) => c.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('spends most slots on the best-scoring time and keeps a share for the untested', () => {
    const chosen = chooseSlots(scores, {
      from: FROM,
      weeks: 4,
      perWeek: 2,
      minGapHours: 20,
      exploreShare: DEFAULT_EXPLORE_SHARE,
    });
    const explore = chosen.filter((c) => c.explore);
    // One in five, spread out rather than clustered.
    expect(explore).toHaveLength(Math.round(chosen.length * DEFAULT_EXPLORE_SHARE));
    expect(explore.every((c) => c.slot.samples === 0)).toBe(true);
    // The rest go to the hour this brand has actually done well in.
    const exploit = chosen.filter((c) => !c.explore);
    expect(exploit.some((c) => c.slot.key === '6-18')).toBe(true);
  });

  it('does not spend an exploring pick re-testing a slot the plan already uses', () => {
    const chosen = chooseSlots(scores, {
      from: FROM,
      weeks: 4,
      perWeek: 2,
      minGapHours: 20,
      exploreShare: DEFAULT_EXPLORE_SHARE,
    });
    for (const explore of chosen.filter((c) => c.explore)) {
      const others = chosen.filter((c) => c !== explore);
      // Re-testing the slot that would have been picked anyway teaches
      // nothing, which is the whole purpose of the reserved share.
      expect(others.map((c) => c.slot.key)).not.toContain(explore.slot.key);
    }
  });

  it('keeps every release at least the minimum gap apart, across the week seam', () => {
    const chosen = chooseSlots(scores, { from: FROM, weeks: 3, perWeek: 3, minGapHours: 40 });
    const times = chosen.map((c) => c.at.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(40 * 3_600_000);
    }
  });

  it('stays inside the hours and days it is allowed', () => {
    const chosen = chooseSlots(scores, {
      from: FROM,
      weeks: 4,
      perWeek: 1,
      hours: [9, 10],
      days: [1, 2],
      exploreShare: 0,
    });
    expect(chosen.length).toBeGreaterThan(0);
    for (const c of chosen) {
      const slot = slotOf(c.at, DEFAULT_ZONE);
      expect([9, 10]).toContain(slot.hour);
      expect([1, 2]).toContain(slot.day);
    }
  });

  it('falls back to the prior when the brand has no history at all', () => {
    const chosen = chooseSlots(blank, { from: FROM, weeks: 2, perWeek: 1, exploreShare: 0 });
    expect(chosen).toHaveLength(2);
    // The prior's own peak: a weekday evening.
    for (const c of chosen) {
      expect(c.slot.basis).toBe('prior');
      expect(c.slot.hour).toBeGreaterThanOrEqual(17);
      expect(c.slot.hour).toBeLessThanOrEqual(21);
    }
  });
});

describe('buildPlan', () => {
  it('gives every item a slot, in order, and schedules nothing itself', () => {
    const plan = buildPlan(items(6), scores, options({ weeks: 2, perWeek: 3 }));
    expect(plan.assignments).toHaveLength(6);
    expect(plan.unplaced).toEqual([]);
    expect(plan.approvedAt).toBeUndefined();
    expect(plan.applied).toEqual([]);
    // The batch keeps its order: clip-01 goes out first.
    expect(plan.assignments.map((a) => a.id)).toEqual([
      'clip-01',
      'clip-02',
      'clip-03',
      'clip-04',
      'clip-05',
      'clip-06',
    ]);
    const times = plan.assignments.map((a) => a.publishAt);
    expect([...times].sort()).toEqual(times);
    expect(plan.samples).toBe(history.length);
  });

  it('releases them in the order they were handed over, whatever their ids', () => {
    // Ids are content hashes and sort arbitrarily; a batch of clips is often
    // a sequence, so the order the caller gives is the order they go out in.
    const unsorted: PlanItem[] = [
      { id: 'zzz-00000001', title: 'First', kind: 'short' },
      { id: 'aaa-00000002', title: 'Second', kind: 'short' },
      { id: 'mmm-00000003', title: 'Third', kind: 'short' },
    ];
    const plan = buildPlan(unsorted, scores, options({ weeks: 2, perWeek: 2 }));
    expect(plan.assignments.map((a) => a.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('explains each slot in words, and marks the ones chosen to test', () => {
    const plan = buildPlan(items(5), scores, options({ weeks: 2, perWeek: 3 }));
    for (const a of plan.assignments) {
      expect(a.reason).toBeTruthy();
      expect(a.slotLabel).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:00$/);
    }
    const explore = plan.assignments.filter((a) => a.explore);
    expect(explore.length).toBeGreaterThan(0);
    expect(explore.every((a) => /testing/.test(a.reason))).toBe(true);
    const proven = plan.assignments.find((a) => a.basis === 'history');
    expect(proven?.reason).toMatch(/past videos here/);
  });

  it('says whether it is the brand or only the slot that has no history', () => {
    // A brand with history, forced into an hour it has never used: the brand
    // is not the unknown here, the hour is, and the plan should say which.
    const untried = buildPlan(
      items(1),
      scores,
      options({ weeks: 1, perWeek: 1, hours: [11], exploreShare: 0 }),
    );
    expect(untried.assignments[0]!.basis).toBe('prior');
    expect(untried.assignments[0]!.reason).toMatch(/nothing published in this slot yet/);

    // A brand with nothing at all behind it says so instead.
    const fresh = buildPlan(items(1), blank, options({ weeks: 1, perWeek: 1 }));
    expect(fresh.assignments[0]!.reason).toMatch(/no history for this brand yet/);
  });

  it('leaves content that already has a slot alone, and says so', () => {
    const withSlot: PlanItem[] = [
      { id: 'done-01', title: 'Already set', kind: 'short', publishAt: '2026-12-01T20:00:00Z' },
      ...items(2),
    ];
    const plan = buildPlan(withSlot, scores, options({ weeks: 1, perWeek: 3 }));
    expect(plan.assignments.map((a) => a.id)).toEqual(['clip-01', 'clip-02']);
    expect(plan.untouched).toEqual([
      { id: 'done-01', title: 'Already set', publishAt: '2026-12-01T20:00:00Z' },
    ]);
  });

  it('moves everything when asked to replan', () => {
    const withSlot: PlanItem[] = [
      { id: 'done-01', title: 'Already set', kind: 'short', publishAt: '2026-12-01T20:00:00Z' },
      ...items(1),
    ];
    const plan = buildPlan(withSlot, scores, options({ weeks: 1, perWeek: 3, replan: true }));
    expect(plan.untouched).toEqual([]);
    expect(plan.assignments.map((a) => a.id).sort()).toEqual(['clip-01', 'done-01']);
  });

  it('never puts a clip out before the episode it came from', () => {
    const parent = '2026-11-30T12:00:00Z';
    const clips: PlanItem[] = [
      { id: 'clip-01', title: 'Clip of a future episode', kind: 'short', notBefore: parent },
      { id: 'clip-02', title: 'Standalone', kind: 'short' },
    ];
    const plan = buildPlan(clips, scores, options({ weeks: 4, perWeek: 3 }));
    const clipOfEpisode = plan.assignments.find((a) => a.id === 'clip-01')!;
    expect(Date.parse(clipOfEpisode.publishAt)).toBeGreaterThanOrEqual(Date.parse(parent));
    // The standalone one is free to go earlier.
    const standalone = plan.assignments.find((a) => a.id === 'clip-02')!;
    expect(Date.parse(standalone.publishAt)).toBeLessThan(Date.parse(parent));
  });

  it('reports a clip it cannot place rather than placing it wrongly', () => {
    const clips: PlanItem[] = [
      {
        id: 'clip-01',
        title: 'Clip of an episode next year',
        kind: 'short',
        notBefore: '2027-06-01T12:00:00Z',
      },
    ];
    const plan = buildPlan(clips, scores, options({ weeks: 2, perWeek: 3 }));
    expect(plan.assignments).toEqual([]);
    expect(plan.unplaced).toEqual([
      {
        id: 'clip-01',
        title: 'Clip of an episode next year',
        reason: 'no free slot after its parent episode (2027-06-01)',
      },
    ]);
  });

  it('warns, and places what it can, when there is more content than window', () => {
    const plan = buildPlan(items(10), scores, options({ weeks: 1, perWeek: 3 }));
    expect(plan.assignments).toHaveLength(3);
    expect(plan.unplaced).toHaveLength(7);
    expect(plan.warnings.join(' ')).toMatch(/10 items need a slot but the window holds 3/);
    expect(plan.unplaced[0]!.reason).toBe('the window ran out of slots');
  });

  it('says plainly when it is guessing because there is no history', () => {
    const plan = buildPlan(items(2), blank, options({ weeks: 1, perWeek: 2 }));
    expect(plan.samples).toBe(0);
    expect(plan.warnings.join(' ')).toMatch(/No published history/);
    expect(plan.assignments.every((a) => a.basis === 'prior')).toBe(true);
  });

  it('passes on the warning that Shorts were scored against long-form', () => {
    const mixed = scoreSlots(
      [
        sample(at18('2026-10-10'), 1000, 'the-one-short'),
        ...MIDWEEK.map((d) => ({ ...sample(at13(d), 1000, `l-${d}`), format: 'long' as const })),
      ],
      { format: 'short', now: NOW },
    );
    const plan = buildPlan(items(1), mixed, options({ weeks: 1, perWeek: 1 }));
    expect(plan.warnings.join(' ')).toMatch(/Too few Shorts to score on their own/);
  });

  it('is deterministic: the same inputs give the same plan', () => {
    const a = buildPlan(items(5), scores, options({ weeks: 2, perWeek: 3 }));
    const b = buildPlan(items(5), scores, options({ weeks: 2, perWeek: 3 }));
    expect(a).toEqual(b);
  });

  it('records the window and the rules it used, so a plan can be read back', () => {
    const plan = buildPlan(items(1), scores, options({ weeks: 3, perWeek: 2, minGapHours: 30 }));
    expect(plan).toMatchObject({
      planId: 'plan-1',
      brand: 'cc',
      outlet: 'youtube',
      zone: DEFAULT_ZONE,
      perWeek: 2,
      minGapHours: 30,
      from: FROM.toISOString(),
    });
    expect(Date.parse(plan.to)).toBeGreaterThan(Date.parse(plan.from));
  });

  it('has nothing to say when nothing is waiting', () => {
    const plan = buildPlan([], scores, options());
    expect(plan.assignments).toEqual([]);
    expect(plan.unplaced).toEqual([]);
    expect(plan.untouched).toEqual([]);
  });
});
