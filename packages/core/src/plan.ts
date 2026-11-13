import { z } from 'zod';
import { CONTENT_KINDS, CONTENT_ID } from './content';
import { OUTLET_ID } from './brand';
import { SLUG } from './model';
import {
  DEFAULT_ZONE,
  fromZoned,
  nextSlotTime,
  rankSlots,
  slotKey,
  slotLabel,
  slotOf,
  untestedSlots,
  zonedDayStart,
  zonedParts,
  type Slot,
  type SlotScore,
  type SlotScores,
} from './slots';

/**
 * The planner. It takes the content with no slot yet, the brand's slot
 * scores, and some rules about how often to post, and lays out a schedule.
 *
 * It writes nothing to any platform. Its whole output is a plan to be read
 * and approved; approving is what puts the times on the content, and the
 * upload sweep only ever acts on content whose slot is near. That split is
 * the point: a bad score or an off-by-one week shows up as a plan that looks
 * wrong, not as a video on the channel.
 */

export const DEFAULT_WEEKS = 4;
export const DEFAULT_PER_WEEK = 3;
/**
 * Hours between two releases. Just under a day, so "three a week" cannot
 * become three on a Friday, while still allowing a daily run.
 */
export const DEFAULT_MIN_GAP_HOURS = 20;
/**
 * The share of slots given to the least-tested times rather than the
 * best-scoring ones. Without it the first slot that happens to do well owns
 * the schedule and nothing is ever learned about the rest of the week.
 */
export const DEFAULT_EXPLORE_SHARE = 0.2;

export const PlanAssignment = z.object({
  id: z.string().regex(CONTENT_ID),
  title: z.string(),
  kind: z.enum(CONTENT_KINDS),
  publishAt: z.iso.datetime(),
  /** The slot it landed in, as `<day>-<hour>`. */
  slot: z.string(),
  /** `Sat 15:00` in the plan's zone. */
  slotLabel: z.string(),
  score: z.number(),
  basis: z.enum(['history', 'blend', 'prior']),
  /** True where the slot was chosen to test it, not because it scored well. */
  explore: z.boolean().default(false),
  /** Plain words for why this time, shown in the review. */
  reason: z.string(),
});
export type PlanAssignment = z.infer<typeof PlanAssignment>;

export const SchedulePlan = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  brand: z.string().regex(SLUG),
  outlet: z.string().regex(OUTLET_ID),
  zone: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** The window slots were drawn from. */
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  perWeek: z.number().int().positive(),
  minGapHours: z.number().nonnegative(),
  exploreShare: z.number().min(0).max(1),
  /** How many past videos the scores rest on. Zero means this is all prior. */
  samples: z.number().int().nonnegative(),
  assignments: z.array(PlanAssignment).default([]),
  /** Content that could not be placed, and why. */
  unplaced: z
    .array(z.object({ id: z.string(), title: z.string(), reason: z.string() }))
    .default([]),
  /** Content left alone because it already had a slot. */
  untouched: z
    .array(z.object({ id: z.string(), title: z.string(), publishAt: z.string() }))
    .default([]),
  warnings: z.array(z.string()).default([]),
  /** Set once the plan has been approved and the times written onto content. */
  approvedAt: z.iso.datetime().optional(),
  /** What approving it actually changed. */
  applied: z.array(z.object({ id: z.string(), publishAt: z.string() })).default([]),
});
export type SchedulePlan = z.infer<typeof SchedulePlan>;
export type SchedulePlanInput = z.input<typeof SchedulePlan>;

export interface PlanItem {
  id: string;
  title: string;
  kind: (typeof CONTENT_KINDS)[number];
  /** A slot it already has. Such an item is reported, never moved. */
  publishAt?: string;
  /**
   * The earliest this may go out — a Short clipped from an episode should
   * not appear before the episode it spoils.
   */
  notBefore?: string;
}

export interface PlanRules {
  zone?: string;
  /** Earliest slot. Callers pass now plus the upload lead time. */
  from: Date;
  weeks?: number;
  perWeek?: number;
  minGapHours?: number;
  /** Days of the week to use at all. Default: every day. */
  days?: number[];
  /** Hours to use at all. Default: every hour the scores allow. */
  hours?: number[];
  exploreShare?: number;
}

interface Candidate {
  at: Date;
  week: number;
  slot: SlotScore;
}

/**
 * Every allowed moment in the window, with the score of the slot it falls
 * in. Built from wall-clock days so an hour means the same thing either side
 * of a daylight saving change.
 */
function candidates(scores: SlotScores, rules: PlanRules): Candidate[] {
  const zone = rules.zone ?? scores.zone ?? DEFAULT_ZONE;
  const weeks = rules.weeks ?? DEFAULT_WEEKS;
  const byKey = new Map(scores.slots.map((s) => [s.key, s]));
  const days = rules.days?.length ? new Set(rules.days) : undefined;
  const hours = rules.hours?.length ? new Set(rules.hours) : undefined;
  const out: Candidate[] = [];

  for (let offset = 0; offset < weeks * 7; offset++) {
    const dayStart = zonedDayStart(rules.from, zone, offset);
    const p = zonedParts(dayStart, zone);
    for (let hour = 0; hour < 24; hour++) {
      if (hours && !hours.has(hour)) continue;
      const at = fromZoned({ year: p.year, month: p.month, date: p.date, hour }, zone);
      if (at.getTime() <= rules.from.getTime()) continue;
      const slot = slotOf(at, zone);
      if (days && !days.has(slot.day)) continue;
      const score = byKey.get(slotKey(slot));
      if (!score) continue;
      out.push({ at, week: Math.floor(offset / 7), slot: score });
    }
  }
  return out;
}

/**
 * Picks the times. Each week gets `perWeek` of them, chosen best-first from
 * the scores, except for the share reserved for the least-tested slots. A
 * minimum gap is enforced across the whole schedule, not just within a week,
 * so the seam between two weeks cannot bunch up.
 */
export function chooseSlots(
  scores: SlotScores,
  rules: PlanRules,
): { at: Date; slot: SlotScore; explore: boolean }[] {
  const perWeek = rules.perWeek ?? DEFAULT_PER_WEEK;
  const weeks = rules.weeks ?? DEFAULT_WEEKS;
  const minGapMs = (rules.minGapHours ?? DEFAULT_MIN_GAP_HOURS) * 3_600_000;
  const share = Math.min(Math.max(rules.exploreShare ?? DEFAULT_EXPLORE_SHARE, 0), 1);
  const pool = candidates(scores, rules);

  const bestFirst = new Map(rankSlots(scores.slots).map((s, i) => [s.key, i]));
  const leastTested = new Map(untestedSlots(scores.slots).map((s, i) => [s.key, i]));
  const chosen: { at: Date; slot: SlotScore; explore: boolean }[] = [];
  const used = new Set<number>();
  const usedKeys = new Set<string>();
  let pick = 0;

  const fits = (at: Date) =>
    chosen.every((c) => Math.abs(c.at.getTime() - at.getTime()) >= minGapMs);

  /**
   * The best candidate in one week. `fresh` makes a pick refuse slots the
   * plan already uses, which is what an exploring pick needs: re-testing the
   * slot that would have been chosen anyway teaches nothing.
   */
  const choose = (week: number, order: Map<string, number>, fresh: boolean) => {
    let best: { index: number; rank: number } | undefined;
    for (const [index, candidate] of pool.entries()) {
      if (used.has(index) || candidate.week !== week || !fits(candidate.at)) continue;
      if (fresh && usedKeys.has(candidate.slot.key)) continue;
      const rank = order.get(candidate.slot.key) ?? Number.MAX_SAFE_INTEGER;
      if (!best || rank < best.rank) best = { index, rank };
    }
    return best;
  };

  for (let week = 0; week < weeks; week++) {
    for (let inWeek = 0; inWeek < perWeek; inWeek++) {
      // Bresenham-style interleave: exactly `share` of picks explore, spread
      // evenly rather than clustered at the start.
      const explore = share > 0 && Math.round((pick + 1) * share) > Math.round(pick * share);
      const order = explore ? leastTested : bestFirst;
      // A repeat of a proven slot is the point of an exploiting pick, so only
      // an exploring one insists on a slot the plan has not used; and if the
      // week has nothing left unused, it takes what it can rather than
      // wasting the slot.
      const best = (explore ? choose(week, order, true) : undefined) ?? choose(week, order, false);
      pick++;
      if (!best) continue;
      used.add(best.index);
      const candidate = pool[best.index]!;
      usedKeys.add(candidate.slot.key);
      chosen.push({ at: candidate.at, slot: candidate.slot, explore });
    }
  }
  return chosen.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function reasonFor(slot: SlotScore, explore: boolean, brandSamples: number): string {
  const videos = (n: number) => `${n} past video${n === 1 ? '' : 's'}`;
  if (explore) {
    return slot.samples
      ? `testing a thin slot (${videos(slot.samples)} here)`
      : 'testing a slot nothing has been published in yet';
  }
  switch (slot.basis) {
    case 'history':
      return `${videos(slot.samples)} here averaged ${slot.score.toFixed(2)}x a typical slot`;
    case 'blend':
      return `${videos(slot.samples)} here, blended with the general prior`;
    default:
      // The distinction matters when reading a plan: a brand with history
      // whose evenings are untried is in a different position from a brand
      // that has never published anything.
      return brandSamples
        ? 'nothing published in this slot yet: general prior for the hour'
        : 'no history for this brand yet: general peak-time prior';
  }
}

export interface PlanOptions extends PlanRules {
  planId: string;
  brand: string;
  outlet: string;
  now: Date;
  /** Give items that already have a slot a new one as well. */
  replan?: boolean;
}

/**
 * Lays out a schedule for the content that needs one. Deterministic: the
 * same content, scores and rules always give the same plan, so a plan can be
 * reviewed, rebuilt and compared.
 */
export function buildPlan(items: PlanItem[], scores: SlotScores, opts: PlanOptions): SchedulePlan {
  const zone = opts.zone ?? scores.zone ?? DEFAULT_ZONE;
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const warnings: string[] = [];

  const untouched = opts.replan ? [] : items.filter((i) => i.publishAt);
  // The order they arrive in is the order they go out in. Nothing is sorted
  // here: a batch of clips is often a sequence, and the caller is the only
  // one that knows what order its author wrote them in.
  const needing = opts.replan ? items : items.filter((i) => !i.publishAt);

  const slots = chooseSlots(scores, { ...opts, zone, weeks });
  if (!scores.samples) {
    warnings.push(
      'No published history for this brand yet, so every slot is the general prior. Scores get real once videos have been out for three days.',
    );
  }
  if (scores.fellBackToAllFormats) {
    warnings.push(
      'Too few Shorts to score on their own, so long-form history was used too. Expect the scores to shift as Shorts build up.',
    );
  }
  if (slots.length < needing.length) {
    warnings.push(
      `${needing.length} items need a slot but the window holds ${slots.length}. Widen it with --weeks, or post more often with --per-week.`,
    );
  }

  const assignments: PlanAssignment[] = [];
  const unplaced: { id: string; title: string; reason: string }[] = [];
  const taken = new Set<number>();

  for (const item of needing) {
    const earliest = item.notBefore ? Date.parse(item.notBefore) : -Infinity;
    const index = slots.findIndex((s, i) => !taken.has(i) && s.at.getTime() >= earliest);
    if (index < 0) {
      unplaced.push({
        id: item.id,
        title: item.title,
        reason: item.notBefore
          ? `no free slot after its parent episode (${item.notBefore.slice(0, 10)})`
          : 'the window ran out of slots',
      });
      continue;
    }
    taken.add(index);
    const { at, slot, explore } = slots[index]!;
    assignments.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      publishAt: at.toISOString(),
      slot: slot.key,
      slotLabel: slotLabel(slot),
      score: Number(slot.score.toFixed(3)),
      basis: slot.basis,
      explore,
      reason: reasonFor(slot, explore, scores.samples),
    });
  }

  const end = zonedDayStart(opts.from, zone, weeks * 7);
  return SchedulePlan.parse({
    schemaVersion: 1,
    planId: opts.planId,
    brand: opts.brand,
    outlet: opts.outlet,
    zone,
    createdAt: opts.now.toISOString(),
    from: opts.from.toISOString(),
    to: end.toISOString(),
    perWeek: opts.perWeek ?? DEFAULT_PER_WEEK,
    minGapHours: opts.minGapHours ?? DEFAULT_MIN_GAP_HOURS,
    exploreShare: opts.exploreShare ?? DEFAULT_EXPLORE_SHARE,
    samples: scores.samples,
    assignments: assignments.sort((a, b) => a.publishAt.localeCompare(b.publishAt)),
    unplaced,
    untouched: untouched.map((i) => ({ id: i.id, title: i.title, publishAt: i.publishAt! })),
    warnings,
  } satisfies SchedulePlanInput);
}

/** The next time one slot comes round, for a heatmap tooltip or a dry run. */
export function nextTimeFor(slot: Slot, after: Date, zone = DEFAULT_ZONE): Date {
  return nextSlotTime(after, slot, zone);
}
