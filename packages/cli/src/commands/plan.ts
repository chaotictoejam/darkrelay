import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DAY_NAMES,
  slotLabel,
  type SchedulePlan,
  type SlotScore,
  type SlotScores,
} from '@darkrelay/core';
import { stackOutputs, type GlobalOptions } from '../context';

const region = 'us-east-1';

/**
 * Planning from the command line. Every command here is a read or a
 * proposal, except `plan approve`, which is the one that writes the times
 * onto the content — and even that uploads nothing: the hourly sweep does
 * that when each slot comes close.
 */

interface PlanFlags {
  outlet?: string;
  weeks?: string;
  perWeek?: string;
  minGap?: string;
  hours?: string;
  days?: string;
  explore?: string;
  since?: string;
  leadDays?: string;
  zone?: string;
  replan?: boolean;
  approve?: boolean;
}

const number = (value: string | undefined, what: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number, not "${value}"`);
  return n;
};

/** `--hours 15,18,20` or `--hours 9-17`. */
export function hourList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const hours = new Set<number>();
  for (const part of value.split(',')) {
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(part.trim());
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to) throw new Error(`--hours ${part}: ${from} is after ${to}`);
      for (let h = from; h <= to; h++) hours.add(h);
    } else {
      hours.add(Number(part.trim()));
    }
  }
  const bad = [...hours].filter((h) => !Number.isInteger(h) || h < 0 || h > 23);
  if (bad.length) throw new Error(`--hours: ${bad.join(', ')} is not an hour of the day (0-23)`);
  return [...hours].sort((a, b) => a - b);
}

/** `--days sat,sun` or `--days 0,6`. */
export function dayList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const days = value.split(',').map((part) => {
    const name = part.trim().slice(0, 3).toLowerCase();
    const byName = DAY_NAMES.findIndex((d) => d.toLowerCase() === name);
    if (byName >= 0) return byName;
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
    throw new Error(`--days: "${part.trim()}" is not a day (Sun-Sat, or 0-6)`);
  });
  return [...new Set(days)].sort((a, b) => a - b);
}

async function invokePlanner(global: GlobalOptions, event: Record<string, unknown>) {
  const outputs = await stackOutputs(global, 'Analytics');
  const name = outputs['ShortsPlannerFunctionName'];
  if (!name) {
    throw new Error(
      'The analytics stack has no ShortsPlannerFunctionName output. Deploy the planner first: npm run deploy',
    );
  }
  const r = await new LambdaClient({ region }).send(
    new InvokeCommand({
      FunctionName: name,
      Payload: new TextEncoder().encode(JSON.stringify(event)),
    }),
  );
  const body = new TextDecoder().decode(r.Payload ?? new Uint8Array());
  if (r.FunctionError) {
    const detail = JSON.parse(body || '{}') as { errorMessage?: string };
    throw new Error(`The planner failed: ${detail.errorMessage ?? body}`);
  }
  return JSON.parse(body || 'null');
}

/** A moment as the clock reads it where the audience is. */
function inZone(iso: string, zone: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

export function printPlan(plan: SchedulePlan) {
  const zone = plan.zone;
  console.log(`Plan ${plan.planId} for ${plan.brand} -> ${plan.outlet}`);
  console.log(
    `  ${plan.perWeek} a week, ${plan.minGapHours}h apart, in ${zone}, from ${plan.from.slice(0, 10)} to ${plan.to.slice(0, 10)}`,
  );
  console.log(
    plan.samples
      ? `  Scored on ${plan.samples} past video${plan.samples === 1 ? '' : 's'}.`
      : '  No history to score on yet.',
  );
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);

  if (plan.assignments.length) {
    console.log('');
    for (const a of plan.assignments) {
      const mark = a.explore ? '*' : ' ';
      console.log(`${mark} ${inZone(a.publishAt, zone).padEnd(26)} ${a.title}`);
      console.log(`    ${a.slotLabel}  score ${a.score.toFixed(2)}  ${a.reason}`);
    }
    if (plan.assignments.some((a) => a.explore)) {
      console.log('\n  * a slot chosen to test it, not because it scored well');
    }
  }
  if (plan.untouched.length) {
    console.log(`\nAlready had a slot (left alone; --replan moves them):`);
    for (const i of plan.untouched) {
      console.log(`  ${inZone(i.publishAt, zone).padEnd(26)} ${i.title}`);
    }
  }
  if (plan.unplaced.length) {
    console.log('\nNo slot found:');
    for (const i of plan.unplaced) console.log(`  ${i.title}: ${i.reason}`);
  }
  if (!plan.assignments.length && !plan.unplaced.length && !plan.untouched.length) {
    console.log('\nNothing is waiting for a slot.');
  }
}

/**
 * Proposes a schedule. Writes nothing to any content record: the plan is
 * stored to be read, and approving it is a separate command.
 */
export async function planShorts(brand: string, flags: PlanFlags, global: GlobalOptions) {
  const plan = (await invokePlanner(global, {
    action: 'plan',
    request: {
      brand,
      outlet: flags.outlet,
      zone: flags.zone,
      weeks: number(flags.weeks, '--weeks'),
      perWeek: number(flags.perWeek, '--per-week'),
      minGapHours: number(flags.minGap, '--min-gap'),
      hours: hourList(flags.hours),
      days: dayList(flags.days),
      exploreShare: number(flags.explore, '--explore'),
      sinceDays: number(flags.since, '--since'),
      leadDays: number(flags.leadDays, '--lead-days'),
      replan: flags.replan,
    },
  })) as SchedulePlan;

  printPlan(plan);
  if (!plan.assignments.length) return;
  if (!flags.approve) {
    console.log(
      `\nNothing is scheduled yet. To take it:\n  darkrelay shorts plan approve ${brand} ${plan.planId}`,
    );
    return;
  }
  console.log('');
  await approveShortsPlan(brand, plan.planId, global);
}

/** The one command that puts a plan's times onto the content. */
export async function approveShortsPlan(brand: string, planId: string, global: GlobalOptions) {
  const result = (await invokePlanner(global, { action: 'approve', brand, planId })) as {
    plan: SchedulePlan;
    applied: { id: string; publishAt: string }[];
    skipped: { id: string; reason: string }[];
  };
  console.log(`Approved ${planId}: ${result.applied.length} item(s) have a slot.`);
  for (const s of result.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  const next = result.applied
    .map((a) => a.publishAt)
    .sort()
    .at(0);
  if (next) {
    console.log(
      `\nFirst one goes live ${inZone(next, result.plan.zone)}; it uploads a few days before that.`,
    );
  }
  console.log('Nothing is on YouTube yet. Watch it with: darkrelay shorts list ' + brand);
}

export async function listShortsPlans(brand: string, global: GlobalOptions) {
  const plans = (await invokePlanner(global, { action: 'plans', brand })) as SchedulePlan[];
  if (!plans.length) {
    return console.log(`No plans for ${brand}. Make one: darkrelay shorts plan ${brand}`);
  }
  for (const p of plans) {
    const state = p.approvedAt ? `approved ${p.approvedAt.slice(0, 10)}` : 'not approved';
    console.log(
      `${p.planId}  ${p.assignments.length} item(s)  ${state}  (${p.from.slice(0, 10)} to ${p.to.slice(0, 10)})`,
    );
  }
}

export async function showShortsPlan(brand: string, planId: string, global: GlobalOptions) {
  const plan = (await invokePlanner(global, { action: 'show', brand, planId })) as SchedulePlan;
  printPlan(plan);
  if (plan.approvedAt) console.log(`\nApproved ${plan.approvedAt}.`);
  else {
    console.log(`\nNot approved. To take it:\n  darkrelay shorts plan approve ${brand} ${planId}`);
  }
}

export const RAMP = ['·', '░', '▒', '▓', '█'];

/** A cell of the heatmap. Untested slots stay blank, which is information too. */
function cell(slot: SlotScore, max: number): string {
  if (!slot.samples) return ' ';
  const level =
    max > 0 ? Math.min(Math.floor((slot.score / max) * RAMP.length), RAMP.length - 1) : 0;
  return RAMP[level]!;
}

/**
 * The week as a block of text: a row per day, a column per hour. Only slots
 * with history are shaded, so the blank space is the honest picture of how
 * much of the week has never been tried.
 */
export function heatmapLines(scores: SlotScores): string[] {
  const max = Math.max(...scores.slots.map((s) => s.score));
  const tens = Array.from({ length: 24 }, (_, h) => String(Math.floor(h / 10) || ' ')).join('');
  const units = Array.from({ length: 24 }, (_, h) => String(h % 10)).join('');
  const lines = [`     ${tens}`, `     ${units}`];
  for (let day = 0; day < 7; day++) {
    const row = scores.slots
      .filter((s) => s.day === day)
      .sort((a, b) => a.hour - b.hour)
      .map((s) => cell(s, max))
      .join('');
    lines.push(`${DAY_NAMES[day]}  ${row}`);
  }
  return lines;
}

/**
 * The week as the brand's own numbers see it. Blank means nothing has ever
 * been published then — which is exactly what the planner's reserved share
 * of slots exists to fix.
 */
export async function showSlots(
  brand: string,
  flags: { zone?: string; format?: string; since?: string },
  global: GlobalOptions,
) {
  const scores = (await invokePlanner(global, {
    action: 'slots',
    brand,
    zone: flags.zone,
    format: flags.format,
    sinceDays: number(flags.since, '--since'),
  })) as SlotScores;

  console.log(`Slot scores for ${brand}, in ${scores.zone}`);
  console.log(
    scores.samples
      ? `Built from ${scores.samples} past video${scores.samples === 1 ? '' : 's'}${scores.fellBackToAllFormats ? ' (too few Shorts to score alone, so long-form is included)' : ''}.`
      : 'No settled history yet: every slot below is the general prior.',
  );
  console.log('');
  for (const line of heatmapLines(scores)) console.log(line);
  console.log(`\n  ${RAMP.join(' ')}  weakest to strongest; blank = never tried`);

  const tested = scores.slots.filter((s) => s.samples).sort((a, b) => b.score - a.score);
  if (tested.length) {
    console.log('\nBest of what has been tried:');
    for (const s of tested.slice(0, 5)) {
      const views = s.views === undefined ? '' : `, ${Math.round(s.views)} views in 72h`;
      console.log(
        `  ${slotLabel(s).padEnd(10)} ${s.score.toFixed(2)}  (${s.samples} video${s.samples === 1 ? '' : 's'}${views})`,
      );
    }
  }
  const untried = scores.slots.filter((s) => !s.samples).length;
  console.log(
    `\n${tested.length} slot(s) have history; ${untried} have never been tried. A plan spends part of its slots on those on purpose.`,
  );
}
