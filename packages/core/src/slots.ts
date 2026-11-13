import type { VideoFormat } from './analytics/metrics';

/**
 * Slot scoring: which publish times have worked for this brand.
 *
 * The YouTube Analytics API has no hour-of-day dimension, so there is no way
 * to ask when an audience is awake. What it does report is how each video
 * did, and we know when each one went out — so the scores here are built
 * from the brand's own history, bucketed by the day of week and hour it was
 * published in, in the brand's own timezone.
 *
 * Two things follow from how little data a personal channel has. One viral
 * Short must not be allowed to own a slot forever, so every sample is
 * measured against the brand's median and clamped before it is averaged. And
 * a slot with one sample is barely evidence, so every bucket is pulled back
 * toward a weak prior in proportion to how little it holds.
 */

/** Where "evening" means what the audience thinks it means. */
export const DEFAULT_ZONE = 'America/New_York';

export interface Slot {
  /** 0 = Sunday, to match `Date.getUTCDay`. */
  day: number;
  /** 0-23, in the brand's zone. */
  hour: number;
}

export const SLOT_COUNT = 7 * 24;

export function slotKey(slot: Slot): string {
  return `${slot.day}-${slot.hour}`;
}

export function parseSlotKey(key: string): Slot | undefined {
  const m = /^([0-6])-(\d{1,2})$/.exec(key);
  const hour = m ? Number(m[2]) : 24;
  return m && hour < 24 ? { day: Number(m[1]), hour } : undefined;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `Sat 15:00`, for a plan or a heatmap axis. */
export function slotLabel(slot: Slot): string {
  return `${DAY_NAMES[slot.day] ?? '?'} ${String(slot.hour).padStart(2, '0')}:00`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(zone, f);
  }
  return f;
}

export interface ZonedParts extends Slot {
  year: number;
  month: number;
  date: number;
  minute: number;
  second: number;
}

/**
 * A moment as the clock in `zone` shows it. Built on Intl rather than a
 * timezone library because the only thing needed is wall-clock parts, and
 * Node carries the zone database already.
 */
export function zonedParts(at: Date | string | number, zone = DEFAULT_ZONE): ZonedParts {
  const date = at instanceof Date ? at : new Date(at);
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    date: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
    day: DAY_NAMES.indexOf((parts['weekday'] ?? '') as (typeof DAY_NAMES)[number]),
  };
}

/** The slot a moment falls in. */
export function slotOf(at: Date | string | number, zone = DEFAULT_ZONE): Slot {
  const { day, hour } = zonedParts(at, zone);
  return { day, hour };
}

/** How far `zone` is from UTC at a given moment, in milliseconds. */
function offsetMs(at: Date, zone: string): number {
  const p = zonedParts(at, zone);
  return Date.UTC(p.year, p.month - 1, p.date, p.hour, p.minute, p.second) - at.getTime();
}

/**
 * The moment when the clock in `zone` reads this wall time. Solved rather
 * than looked up: guess with one offset, then re-read the offset at the
 * guess, which settles everywhere except inside the hour that daylight
 * saving skips — there the result lands on the hour after it, which is the
 * sensible answer for a publish time anyway.
 */
export function fromZoned(
  parts: { year: number; month: number; date: number; hour: number; minute?: number },
  zone = DEFAULT_ZONE,
): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour, parts.minute ?? 0);
  let t = wall - offsetMs(new Date(wall), zone);
  t = wall - offsetMs(new Date(t), zone);
  return new Date(t);
}

/** Midnight in `zone` on the day `at` falls in, plus `addDays`. */
export function zonedDayStart(at: Date, zone = DEFAULT_ZONE, addDays = 0): Date {
  const p = zonedParts(at, zone);
  return fromZoned({ year: p.year, month: p.month, date: p.date + addDays, hour: 0 }, zone);
}

/** The first moment strictly after `after` that falls in `slot`. */
export function nextSlotTime(after: Date, slot: Slot, zone = DEFAULT_ZONE): Date {
  for (let offset = 0; offset <= 8; offset++) {
    const day = zonedDayStart(after, zone, offset);
    const p = zonedParts(day, zone);
    const candidate = fromZoned(
      { year: p.year, month: p.month, date: p.date, hour: slot.hour },
      zone,
    );
    if (candidate.getTime() > after.getTime() && slotOf(candidate, zone).day === slot.day) {
      return candidate;
    }
  }
  // Unreachable for a valid slot: every weekday occurs within eight days.
  throw new Error(`No time in the next week matches ${slotLabel(slot)}`);
}

/**
 * How one published video did, early on. "Early" is the first 72 hours
 * because that is where a publish time can still be felt: after a few days a
 * Short lives or dies by the feed, not by when it went up.
 */
export interface SlotSample {
  /** For reporting which videos a score rests on. */
  id: string;
  title?: string;
  /** When it actually went live. */
  publishedAt: string;
  format: VideoFormat;
  views72h: number;
  watchSeconds72h: number;
  durationSeconds?: number;
  subscribersGained72h?: number;
}

/** The weights of the three signals, before any missing one is redistributed. */
export const SIGNAL_WEIGHTS = { reach: 0.5, retention: 0.3, growth: 0.2 } as const;

/**
 * How far a single video is allowed to sit from the brand's median. A Short
 * that did thirty times the usual counts as three times the usual: the point
 * of a slot score is "this hour tends to work", and one runaway hit is not
 * evidence about an hour.
 */
export const OUTLIER_CLAMP = 3;

/**
 * Weight of the prior, in samples. A bucket with two videos in it sits
 * halfway between what those two did and the prior.
 */
export const PRIOR_WEIGHT = 2;

/** At or above this many samples a bucket is read as its own evidence. */
export const CONFIDENT_SAMPLES = 4;

const HOUR_PRIOR = [
  // 00-05: asleep.
  0.45, 0.4, 0.4, 0.4, 0.45, 0.55,
  // 06-11: morning, climbing.
  0.75, 0.9, 0.95, 1.0, 1.0, 1.05,
  // 12-17: lunch, afternoon.
  1.15, 1.1, 1.1, 1.2, 1.25, 1.3,
  // 18-23: evening peak, then falling away.
  1.4, 1.4, 1.35, 1.2, 0.95, 0.7,
];

const PRIOR_PEAK = Math.max(...HOUR_PRIOR);

/**
 * The fallback for a slot with no history: a weak, deliberately coarse guess
 * that evenings beat small hours and that the days barely differ.
 *
 * Scaled so the very best untested slot is worth exactly one typical slot
 * and never more. That ceiling matters: a prior that could score above 1
 * would let a slot nothing is known about outrank a slot that has earned a
 * good number, and the heatmap's brightest cells would be the ones with no
 * evidence behind them. Untested slots get their turn because the planner
 * reserves a share of every schedule for them, which is a decision anyone
 * can see in the plan, rather than because the prior quietly flatters them.
 */
export function slotPrior(slot: Slot): number {
  const hour = (HOUR_PRIOR[slot.hour] ?? 1) / PRIOR_PEAK;
  // Near-flat on purpose: which weekday suits a brand is exactly the kind of
  // thing its own history answers and a general prior cannot.
  const day = slot.day === 0 || slot.day === 6 ? 0.95 : 1;
  return hour * day;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Share of a video watched, 0-1. Absent where the duration isn't known. */
function viewRatio(sample: SlotSample): number | undefined {
  if (!sample.durationSeconds || !sample.views72h) return undefined;
  const ratio = sample.watchSeconds72h / sample.views72h / sample.durationSeconds;
  return Number.isFinite(ratio) ? Math.min(ratio, 1) : undefined;
}

/** Subscribers per thousand views, so growth is not just a second reach signal. */
function subsPerMille(sample: SlotSample): number | undefined {
  if (sample.subscribersGained72h === undefined || !sample.views72h) return undefined;
  return (sample.subscribersGained72h / sample.views72h) * 1000;
}

function relative(value: number, centre: number): number {
  if (!centre) return 1;
  return Math.min(Math.max(value / centre, 1 / OUTLIER_CLAMP), OUTLIER_CLAMP);
}

export interface SlotScore extends Slot {
  key: string;
  /** 1.0 is a typical slot for this brand. Higher is better. */
  score: number;
  /** Videos published in this bucket. */
  samples: number;
  /** What the score would be with no history at all. */
  prior: number;
  /** Whether the number is the brand's own evidence, the prior, or a mix. */
  basis: 'history' | 'blend' | 'prior';
  /** Median first-72h views in the bucket, for display. */
  views?: number;
  /** Median share of the video watched, 0-1. */
  viewRatio?: number;
  /** Median subscribers gained per 1,000 views. */
  subsPerMille?: number;
  /** The videos behind it, newest first. */
  evidence?: { id: string; title?: string; publishedAt: string }[];
}

export interface ScoreOptions {
  zone?: string;
  /**
   * Only score against videos of this format. A three-minute talk says
   * nothing about when to post a Short, so a Short is scored against Shorts
   * where there are any.
   */
  format?: VideoFormat;
  /** Ignore anything older than this. Tastes and audiences move. */
  sinceDays?: number;
  now?: Date;
}

export interface SlotScores {
  zone: string;
  /** The samples the scores were actually built from. */
  samples: number;
  /** Set when a format filter was asked for but there was too little of it. */
  fellBackToAllFormats?: boolean;
  slots: SlotScore[];
}

/**
 * Scores all 168 slots for one brand. Every slot comes back, so a caller can
 * draw a heatmap and the planner can pick from the whole week; the ones with
 * no history are honestly marked as the prior.
 */
export function scoreSlots(history: SlotSample[], opts: ScoreOptions = {}): SlotScores {
  const zone = opts.zone ?? DEFAULT_ZONE;
  const now = opts.now ?? new Date();
  const cutoff = opts.sinceDays ? now.getTime() - opts.sinceDays * 86_400_000 : -Infinity;
  const recent = history.filter((s) => Date.parse(s.publishedAt) >= cutoff);

  // A format is only worth isolating if there is enough of it to learn from.
  let samples = opts.format ? recent.filter((s) => s.format === opts.format) : recent;
  let fellBack = false;
  if (opts.format && samples.length < CONFIDENT_SAMPLES && recent.length > samples.length) {
    samples = recent;
    fellBack = true;
  }

  const reachCentre = median(samples.map((s) => s.views72h));
  const ratios = samples.map(viewRatio).filter((v): v is number => v !== undefined);
  const ratioCentre = median(ratios);
  const subs = samples.map(subsPerMille).filter((v): v is number => v !== undefined);
  const subsCentre = median(subs);

  const buckets = new Map<string, SlotSample[]>();
  for (const sample of samples) {
    const key = slotKey(slotOf(sample.publishedAt, zone));
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(sample);
  }

  const slots: SlotScore[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const slot = { day, hour };
      const key = slotKey(slot);
      const prior = slotPrior(slot);
      const inBucket = buckets.get(key) ?? [];
      const n = inBucket.length;
      if (!n) {
        slots.push({ ...slot, key, score: prior, samples: 0, prior, basis: 'prior' });
        continue;
      }
      const composites = inBucket.map((sample) =>
        composite(sample, { reachCentre, ratioCentre, subsCentre }),
      );
      const own = median(composites);
      // Shrinkage: little evidence stays close to the prior, more evidence
      // pulls away from it. Nothing is ever all one or all the other.
      const score = (n * own + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
      const bucketRatios = inBucket.map(viewRatio).filter((v): v is number => v !== undefined);
      const bucketSubs = inBucket.map(subsPerMille).filter((v): v is number => v !== undefined);
      slots.push({
        ...slot,
        key,
        score,
        samples: n,
        prior,
        basis: n >= CONFIDENT_SAMPLES ? 'history' : 'blend',
        views: median(inBucket.map((s) => s.views72h)),
        viewRatio: bucketRatios.length ? median(bucketRatios) : undefined,
        subsPerMille: bucketSubs.length ? median(bucketSubs) : undefined,
        evidence: [...inBucket]
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .slice(0, 5)
          .map((s) => ({ id: s.id, title: s.title, publishedAt: s.publishedAt })),
      });
    }
  }

  return {
    zone,
    samples: samples.length,
    ...(fellBack ? { fellBackToAllFormats: true } : {}),
    slots,
  };
}

/**
 * One video as a single number, relative to the brand's median. Signals the
 * data cannot support are dropped and their weight shared out over the ones
 * that remain, so a channel with no duration or subscriber data still scores
 * on reach instead of scoring everything as average.
 */
function composite(
  sample: SlotSample,
  centres: { reachCentre: number; ratioCentre: number; subsCentre: number },
): number {
  const parts: { weight: number; value: number }[] = [
    { weight: SIGNAL_WEIGHTS.reach, value: relative(sample.views72h, centres.reachCentre) },
  ];
  const ratio = viewRatio(sample);
  if (ratio !== undefined && centres.ratioCentre) {
    parts.push({ weight: SIGNAL_WEIGHTS.retention, value: relative(ratio, centres.ratioCentre) });
  }
  const subs = subsPerMille(sample);
  if (subs !== undefined && centres.subsCentre) {
    parts.push({ weight: SIGNAL_WEIGHTS.growth, value: relative(subs, centres.subsCentre) });
  }
  const total = parts.reduce((sum, p) => sum + p.weight, 0);
  return parts.reduce((sum, p) => sum + (p.weight / total) * p.value, 0);
}

/** Best slots first, then the least-tested, then the week in order. */
export function rankSlots(scores: SlotScore[]): SlotScore[] {
  return [...scores].sort((a, b) => b.score - a.score || a.day - b.day || a.hour - b.hour);
}

/**
 * Slots worth trying because nothing has been tried there. Ordered by how
 * little is known, with the prior breaking ties, so an untested evening
 * comes before an untested 4am.
 */
export function untestedSlots(scores: SlotScore[]): SlotScore[] {
  return [...scores].sort(
    (a, b) => a.samples - b.samples || b.prior - a.prior || a.day - b.day || a.hour - b.hour,
  );
}
