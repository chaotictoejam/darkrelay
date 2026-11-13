import { describe, expect, it } from 'vitest';
import {
  CONFIDENT_SAMPLES,
  DEFAULT_ZONE,
  OUTLIER_CLAMP,
  PRIOR_WEIGHT,
  fromZoned,
  nextSlotTime,
  rankSlots,
  scoreSlots,
  slotKey,
  slotLabel,
  slotOf,
  slotPrior,
  untestedSlots,
  zonedParts,
  type SlotSample,
} from '../src';

const NOW = new Date('2026-11-12T10:00:00Z');

/**
 * A video published at a given moment, with how it did. Watch time follows
 * the view count so the share watched stays at the median unless a test sets
 * out to vary it: that keeps a test about reach from quietly also being a
 * test about retention.
 */
function sample(at: string, over: Partial<SlotSample> = {}, id = at): SlotSample {
  const views72h = over.views72h ?? 1000;
  const durationSeconds = 'durationSeconds' in over ? over.durationSeconds : 30;
  return {
    id,
    publishedAt: new Date(at).toISOString(),
    format: 'short',
    views72h,
    watchSeconds72h: views72h * (durationSeconds ?? 30) * 0.5,
    durationSeconds,
    ...over,
  };
}

/** Real October 2026 dates, so a slot key is a fact and not a guess. */
const SATURDAYS = ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24'];
const SUNDAYS = ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'];
const TUESDAYS = ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'];
const MIDWEEK = [
  '2026-10-06',
  '2026-10-07',
  '2026-10-13',
  '2026-10-14',
  '2026-10-20',
  '2026-10-21',
  '2026-10-27',
  '2026-10-28',
];
/** New York wall-clock times, written as the UTC moment they name. */
const at18 = (date: string) => `${date}T22:00:00Z`;
const at13 = (date: string) => `${date}T17:00:00Z`;
const at04 = (date: string) => `${date}T08:00:00Z`;

describe('zones', () => {
  it('reads a moment as the New York clock shows it, through a DST change', () => {
    // 15:00 UTC is 11:00 EDT in summer and 10:00 EST in winter.
    expect(zonedParts('2026-07-04T15:00:00Z', DEFAULT_ZONE)).toMatchObject({
      year: 2026,
      month: 7,
      date: 4,
      hour: 11,
      day: 6,
    });
    expect(zonedParts('2026-12-04T15:00:00Z', DEFAULT_ZONE)).toMatchObject({ hour: 10, day: 5 });
  });

  it('turns a wall-clock time back into the moment it names', () => {
    expect(fromZoned({ year: 2026, month: 7, date: 4, hour: 18 }, DEFAULT_ZONE).toISOString()).toBe(
      '2026-07-04T22:00:00.000Z',
    );
    expect(
      fromZoned({ year: 2026, month: 12, date: 4, hour: 18 }, DEFAULT_ZONE).toISOString(),
    ).toBe('2026-12-04T23:00:00.000Z');
  });

  it('keeps the same local hour either side of a daylight saving change', () => {
    // US daylight saving ends on 1 November 2026: 18:00 stays 18:00 locally,
    // which is the whole reason slots are wall-clock and not UTC offsets.
    const before = fromZoned({ year: 2026, month: 10, date: 30, hour: 18 }, DEFAULT_ZONE);
    const after = fromZoned({ year: 2026, month: 11, date: 5, hour: 18 }, DEFAULT_ZONE);
    expect(zonedParts(before, DEFAULT_ZONE).hour).toBe(18);
    expect(zonedParts(after, DEFAULT_ZONE).hour).toBe(18);
    // ... and the UTC instants really do differ, by the hour the clocks moved.
    expect(before.toISOString()).toBe('2026-10-30T22:00:00.000Z');
    expect(after.toISOString()).toBe('2026-11-05T23:00:00.000Z');
  });

  it('finds the next time a slot comes round', () => {
    // NOW is Thursday 12 November 2026, 05:00 in New York.
    expect(slotOf(NOW, DEFAULT_ZONE)).toEqual({ day: 4, hour: 5 });
    const saturdayEvening = nextSlotTime(NOW, { day: 6, hour: 18 }, DEFAULT_ZONE);
    expect(slotOf(saturdayEvening, DEFAULT_ZONE)).toEqual({ day: 6, hour: 18 });
    expect(saturdayEvening.toISOString()).toBe('2026-11-14T23:00:00.000Z');
    // A slot still ahead of us today is today.
    expect(nextSlotTime(NOW, { day: 4, hour: 20 }, DEFAULT_ZONE).toISOString()).toBe(
      '2026-11-13T01:00:00.000Z',
    );
    // One that has already gone past today comes round next week.
    expect(nextSlotTime(NOW, { day: 4, hour: 4 }, DEFAULT_ZONE).toISOString()).toBe(
      '2026-11-19T09:00:00.000Z',
    );
  });

  it('labels a slot the way a human reads it', () => {
    expect(slotLabel({ day: 6, hour: 18 })).toBe('Sat 18:00');
    expect(slotKey({ day: 6, hour: 18 })).toBe('6-18');
  });
});

describe('slotPrior', () => {
  it('prefers the evening to the small hours, and barely cares which day', () => {
    expect(slotPrior({ day: 3, hour: 19 })).toBeGreaterThan(slotPrior({ day: 3, hour: 3 }));
    const weekday = slotPrior({ day: 3, hour: 19 });
    const weekend = slotPrior({ day: 6, hour: 19 });
    expect(Math.abs(weekday - weekend) / weekday).toBeLessThan(0.1);
  });

  it('never values a slot it knows nothing about above a typical slot', () => {
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        expect(slotPrior({ day, hour })).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('scoreSlots', () => {
  it('returns the whole week, marking the slots it has no evidence for', () => {
    const scores = scoreSlots([], { now: NOW });
    expect(scores.slots).toHaveLength(168);
    expect(scores.samples).toBe(0);
    expect(scores.slots.every((s) => s.basis === 'prior')).toBe(true);
    expect(scores.slots.every((s) => s.score === s.prior)).toBe(true);
  });

  it('scores a slot its own videos did well in above one they did badly in', () => {
    const scores = scoreSlots(
      [
        ...SATURDAYS.map((d) => sample(at18(d), { views72h: 3000 }, `good-${d}`)),
        ...TUESDAYS.map((d) => sample(at04(d), { views72h: 200 }, `bad-${d}`)),
      ],
      { now: NOW },
    );
    const byKey = new Map(scores.slots.map((s) => [s.key, s]));
    const good = byKey.get('6-18')!;
    const bad = byKey.get('2-4')!;
    expect(good.samples).toBe(4);
    expect(bad.samples).toBe(4);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.basis).toBe('history');
    expect(good.views).toBe(3000);
  });

  it('will not let one viral Short own a slot', () => {
    const ordinary = MIDWEEK.map((d) => sample(at13(d), { views72h: 500 }, `ord-${d}`));
    const saturdaySlot = (history: SlotSample[]) =>
      scoreSlots(history, { now: NOW }).slots.find((s) => s.key === '6-18')!;

    const solid = saturdaySlot([
      ...ordinary,
      sample(at18('2026-10-10'), { views72h: 1500 }, 'solid'),
    ]);
    const viral = saturdaySlot([
      ...ordinary,
      sample(at18('2026-10-10'), { views72h: 50_000 }, 'viral'),
    ]);

    // One video at 3x the brand's median and one at 100x score the same:
    // past the clamp, a runaway hit is evidence about a video, not an hour.
    expect(viral.samples).toBe(1);
    expect(viral.score).toBeCloseTo(solid.score, 10);
    expect(viral.score).toBeLessThan(OUTLIER_CLAMP);

    // And four consistent 3x Sundays beat the single 100x Saturday.
    const both = scoreSlots(
      [
        ...ordinary,
        sample(at18('2026-10-10'), { views72h: 50_000 }, 'viral'),
        ...SUNDAYS.map((d) => sample(at18(d), { views72h: 1500 }, `sun-${d}`)),
      ],
      { now: NOW },
    );
    const byKey = new Map(both.slots.map((s) => [s.key, s]));
    expect(byKey.get('0-18')!.score).toBeGreaterThan(byKey.get('6-18')!.score);
  });

  it('pulls a thin slot toward the prior and a well-tested one away from it', () => {
    // Enough midweek videos that adding Saturdays cannot move the median.
    const base = [...MIDWEEK, '2026-11-03', '2026-11-04'].map((d) =>
      sample(at13(d), { views72h: 1000 }, `base-${d}`),
    );
    const saturday = (date: string) => sample(at18(date), { views72h: 3000 }, `sat-${date}`);
    const saturdaySlot = (history: SlotSample[]) =>
      scoreSlots(history, { now: NOW }).slots.find((s) => s.key === '6-18')!;

    const thin = saturdaySlot([...base, saturday('2026-10-03')]);
    const thick = saturdaySlot([...base, ...SATURDAYS.map(saturday)]);

    expect(thin.samples).toBe(1);
    expect(thin.basis).toBe('blend');
    expect(thick.samples).toBeGreaterThanOrEqual(CONFIDENT_SAMPLES);
    expect(thick.basis).toBe('history');
    // The same per-video performance, four times as much of it: further from
    // the prior, because there is more reason to believe it.
    expect(thick.score).toBeGreaterThan(thin.score);
    expect(Math.abs(thick.score - thick.prior)).toBeGreaterThan(Math.abs(thin.score - thin.prior));
    // One sample sits exactly PRIOR_WEIGHT:1 between its own number and the prior.
    const own = (thin.score * (1 + PRIOR_WEIGHT) - PRIOR_WEIGHT * thin.prior) / 1;
    expect(own).toBeGreaterThan(thin.score);
  });

  it('counts watch time and subscribers, not only views', () => {
    const base = MIDWEEK.slice(0, 4).map((d) => sample(at13(d), {}, `base-${d}`));
    // Two slots with identical view counts; one holds its viewers and wins
    // subscribers, and that is what makes it the better hour.
    const shallow = sample(
      at18('2026-10-10'),
      { watchSeconds72h: 3000, subscribersGained72h: 0 },
      'shallow',
    );
    const deep = sample(
      at18('2026-10-11'),
      { watchSeconds72h: 27_000, subscribersGained72h: 40 },
      'deep',
    );
    const scores = scoreSlots([...base, shallow, deep], { now: NOW });
    const byKey = new Map(scores.slots.map((s) => [s.key, s]));
    expect(byKey.get('0-18')!.score).toBeGreaterThan(byKey.get('6-18')!.score);
    expect(byKey.get('0-18')!.viewRatio).toBeCloseTo(0.9, 5);
    expect(byKey.get('0-18')!.subsPerMille).toBeCloseTo(40, 5);
  });

  it('scores on reach alone when nothing knows the duration', () => {
    const scores = scoreSlots(
      SATURDAYS.map((d, i) =>
        sample(at18(d), { durationSeconds: undefined, views72h: (i + 1) * 1000 }, `n-${d}`),
      ),
      { now: NOW },
    );
    const tested = scores.slots.filter((s) => s.samples);
    // All four are Saturday 18:00, so it is one bucket with four videos.
    expect(tested).toHaveLength(1);
    expect(tested[0]!.samples).toBe(4);
    expect(tested[0]!.viewRatio).toBeUndefined();
    expect(Number.isFinite(tested[0]!.score)).toBe(true);
  });

  it('scores Shorts against Shorts, and says when there were too few to try', () => {
    const shorts = SATURDAYS.concat('2026-10-31').map((d) =>
      sample(at18(d), { format: 'short' }, `s-${d}`),
    );
    const long = TUESDAYS.slice(0, 3).map((d) => sample(at13(d), { format: 'long' }, `l-${d}`));

    const onlyShorts = scoreSlots([...shorts, ...long], { format: 'short', now: NOW });
    expect(onlyShorts.samples).toBe(5);
    expect(onlyShorts.fellBackToAllFormats).toBeUndefined();

    const thin = scoreSlots([shorts[0]!, ...long], { format: 'short', now: NOW });
    expect(thin.fellBackToAllFormats).toBe(true);
    expect(thin.samples).toBe(4);
  });

  it('ignores history older than the window asked for', () => {
    const history = [sample(at18('2025-01-03'), {}, 'old'), sample(at18('2026-11-07'), {}, 'new')];
    expect(scoreSlots(history, { sinceDays: 90, now: NOW }).samples).toBe(1);
    expect(scoreSlots(history, { now: NOW }).samples).toBe(2);
  });

  it('buckets by the brand’s own clock, not UTC', () => {
    // 01:00 UTC on Sunday 8 November is 20:00 on the Saturday in New York.
    const late = [sample('2026-11-08T01:00:00Z', {}, 'late')];
    expect(
      scoreSlots(late, { zone: DEFAULT_ZONE, now: NOW }).slots.find((s) => s.samples)!.key,
    ).toBe('6-20');
    expect(scoreSlots(late, { zone: 'UTC', now: NOW }).slots.find((s) => s.samples)!.key).toBe(
      '0-1',
    );
  });

  it('keeps the videos a score rests on, so a claim can be checked', () => {
    const scores = scoreSlots([sample(at18('2026-10-10'), { title: 'Bus factor' }, 'v1')], {
      now: NOW,
    });
    expect(scores.slots.find((s) => s.samples)!.evidence).toEqual([
      { id: 'v1', title: 'Bus factor', publishedAt: '2026-10-10T22:00:00.000Z' },
    ]);
  });
});

describe('ordering', () => {
  const scores = scoreSlots(
    [
      ...MIDWEEK.map((d) => sample(at13(d), { views72h: 1000 }, `base-${d}`)),
      ...SATURDAYS.map((d) => sample(at18(d), { views72h: 3000 }, `sat-${d}`)),
    ],
    { now: NOW },
  );

  it('ranks a slot that has earned its number above every untested one', () => {
    const ranked = rankSlots(scores.slots);
    expect(ranked[0]!.key).toBe('6-18');
    expect(ranked[0]!.samples).toBe(4);
    expect(ranked[0]!.score).toBeGreaterThan(1);
    const bestUntested = Math.max(...scores.slots.filter((s) => !s.samples).map((s) => s.score));
    expect(bestUntested).toBeLessThanOrEqual(1);
    expect(ranked[0]!.score).toBeGreaterThan(bestUntested);
  });

  it('offers the least-tested slots for exploring, best prior first', () => {
    const untested = untestedSlots(scores.slots);
    expect(untested[0]!.samples).toBe(0);
    expect(untested.at(-1)!.samples).toBeGreaterThan(0);
    // Among slots with nothing to go on, the prior decides the order, so an
    // untested evening is offered before an untested 4am.
    expect(untested[0]!.prior).toBeGreaterThanOrEqual(untested[20]!.prior);
    expect(untested[0]!.hour).toBeGreaterThanOrEqual(12);
  });
});
