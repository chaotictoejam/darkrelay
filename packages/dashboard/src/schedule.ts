import {
  get,
  post,
  type ApprovalResponse,
  type PendingPlan,
  type PlansResponse,
  type ScheduleEntry,
  type ScheduleResponse,
  type SchedulePlan,
  type SlotScore,
  type SlotScoresResponse,
} from './api';
import type { RuntimeConfig } from './auth';
import { slotEditor } from './reschedule';
import { brandIcon, card, el, field, link, scroller, stat } from './ui';
import { compact, formatName, stateNote } from './format';

// `stateNote` reads the same words on a channel page as it does here, so it
// lives in format.ts; re-exported because this is where it was first used.
export { stateNote };

/**
 * The schedule: what is going out, when, and why that time. The calendar is
 * cross-brand because a week's output is one week whichever brand it belongs
 * to; the heatmap is per brand, because a slot score is a statement about one
 * audience.
 */

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How strongly a cell is shaded: five steps, or null where nothing was tried. */
export function heatLevel(slot: SlotScore, max: number): number | null {
  if (!slot.samples) return null;
  if (max <= 0) return 0;
  return Math.min(Math.floor((slot.score / max) * 5), 4);
}

export interface HeatCell extends SlotScore {
  level: number | null;
  label: string;
  title: string;
}

/**
 * The week as cells, each carrying the sentence that explains it. The
 * explanation is built here rather than in the markup so it can be tested:
 * a number nobody can account for is worse than no number.
 */
export function heatGrid(scores: SlotScoresResponse): HeatCell[] {
  const max = Math.max(...scores.slots.map((s) => s.score), 0);
  return scores.slots.map((slot) => {
    const label = `${DAY_NAMES[slot.day] ?? '?'} ${String(slot.hour).padStart(2, '0')}:00`;
    const facts: string[] = [];
    if (slot.samples) {
      facts.push(`${slot.score.toFixed(2)}x a typical slot`);
      facts.push(`${slot.samples} video${slot.samples === 1 ? '' : 's'}`);
      if (slot.views !== undefined) facts.push(`${compact(Math.round(slot.views))} views in 72h`);
      if (slot.viewRatio !== undefined) {
        facts.push(`${Math.round(slot.viewRatio * 100)}% watched`);
      }
      if (slot.subsPerMille) facts.push(`${slot.subsPerMille.toFixed(1)} subs per 1k views`);
    } else {
      facts.push('never tried');
      facts.push(`prior ${slot.prior.toFixed(2)}`);
    }
    return { ...slot, level: heatLevel(slot, max), label, title: `${label} — ${facts.join(', ')}` };
  });
}

/**
 * A brand's content that has a slot and is not out yet, soonest first — what
 * a channel page badges. The schedule lives behind its own route, so this is
 * a second request; a channel page is worth reading without it, so a failure
 * here costs the badges and nothing else.
 */
export async function pendingContent(
  config: RuntimeConfig,
  brand: string,
  outlet?: string,
): Promise<ScheduleEntry[]> {
  try {
    const data = await get<ScheduleResponse>(config, '/schedule');
    return data.upcoming
      .filter(
        (e) =>
          e.brand === brand &&
          e.state !== 'published' &&
          // An item recorded before outlets existed carries none, and a
          // brand's own channel is where it would have gone.
          (!outlet || !e.outlet || e.outlet === outlet),
      )
      .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
  } catch {
    return [];
  }
}

/** A day of the calendar, in the viewer's own time. */
export interface DayGroup {
  key: string;
  label: string;
  entries: ScheduleEntry[];
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Groups entries by the viewer's own calendar day. A cross-brand calendar
 * cannot be in one brand's timezone without lying about the others, so it is
 * in the timezone of the person reading it, and says so.
 */
export function byDay(entries: ScheduleEntry[], now = new Date()): DayGroup[] {
  const groups = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    if (!entry.publishAt) continue;
    const key = dayKey(entry.publishAt);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(entry);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      label: dayLabel(list[0]!.publishAt!, now),
      entries: list.sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? '')),
    }));
}

/** "Today", "Tomorrow", or the date — whichever a person would say. */
export function dayLabel(iso: string, now = new Date()): string {
  const today = dayKey(now.toISOString());
  const key = dayKey(iso);
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000).toISOString());
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000).toISOString());
  if (key === today) return 'Today';
  if (key === tomorrow) return 'Tomorrow';
  if (key === yesterday) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

/** What a row may offer beyond reading: moving this item's slot. */
export interface RowOptions {
  config: RuntimeConfig;
  canSchedule: boolean;
  /** Called after a save, so the list can be drawn again in the new order. */
  onChanged: () => void;
}

function entryRow(entry: ScheduleEntry, opts?: RowOptions) {
  const row = el('li', undefined, entry.state === 'failed' ? 'entry failed' : 'entry');
  const when = el('span', clock(entry.publishAt!), 'entry-time');
  const body = el('div', undefined, 'entry-body');
  const title = el('div', undefined, 'entry-title');
  if (entry.externalId) {
    const a = link(`https://youtu.be/${entry.externalId}`, entry.title);
    a.target = '_blank';
    a.rel = 'noreferrer';
    title.append(a);
  } else {
    title.append(el('span', entry.title));
  }
  title.append(el('span', formatName(entry.kind), 'tag'));
  body.append(title);
  body.append(el('div', `${entry.brandTitle} · ${stateNote(entry)}`, 'muted'));
  for (const w of entry.warnings ?? []) body.append(el('div', w, 'warn'));
  // An item already uploaded to YouTube can be moved too: the worker tells
  // the platform the new time, and nothing is re-uploaded.
  if (opts?.canSchedule) body.append(slotEditor(opts.config, slotTarget(entry), opts.onChanged));
  row.append(when, body);
  return row;
}

const slotTarget = (entry: ScheduleEntry) => ({
  brand: entry.brand,
  id: entry.id,
  title: entry.title,
  publishAt: entry.publishAt,
  state: entry.state,
  externalId: entry.externalId,
});

/** The cross-brand calendar: every brand's next few weeks in one column. */
export async function calendarView(app: HTMLElement, config: RuntimeConfig) {
  const data = await get<ScheduleResponse>(config, '/schedule');
  const now = new Date(data.now);
  const mine = new Set(data.brands.filter((b) => b.canSchedule).map((b) => b.brand));
  // A moved slot changes where the item sits in the list, so the page is
  // drawn again once the answer has been read.
  const rowOptions = (brand: string): RowOptions | undefined =>
    mine.has(brand)
      ? {
          config,
          canSchedule: true,
          onChanged: () => setTimeout(() => void calendarView(app, config), 1500),
        }
      : undefined;
  const sections: HTMLElement[] = [el('h1', 'Schedule')];
  sections.push(
    el(
      'p',
      `Videos and Shorts going out across ${data.brands.length} brand${data.brands.length === 1 ? '' : 's'}, in your own time zone. Episode releases are kept by their feed and are not shown here.`,
      'muted',
    ),
  );

  const stats = el('div', undefined, 'stats');
  stats.append(
    stat('Scheduled', data.upcoming.length),
    stat('Waiting for a slot', data.unscheduled.length),
  );
  const failures = data.upcoming.filter((e) => e.state === 'failed').length;
  if (failures) stats.append(stat('Failed', failures));
  sections.push(stats);

  for (const plan of data.plans) sections.push(planOffer(plan));

  const days = byDay(data.upcoming, now);
  if (days.length) {
    const list = el('div', undefined, 'calendar');
    for (const day of days) {
      const group = el('section', undefined, 'cal-day');
      group.append(el('h3', day.label));
      const items = el('ul', undefined, 'entries');
      for (const entry of day.entries) items.append(entryRow(entry, rowOptions(entry.brand)));
      group.append(items);
      list.append(group);
    }
    sections.push(card('Coming up', list));
  } else {
    sections.push(
      card(
        'Coming up',
        el('p', 'Nothing is scheduled. Plan a brand’s Shorts to fill the weeks ahead.', 'muted'),
      ),
    );
  }

  if (data.unscheduled.length) {
    const list = el('ul', undefined, 'entries');
    for (const entry of data.unscheduled) {
      const row = el('li', undefined, 'entry');
      row.append(el('span', '—', 'entry-time'));
      const body = el('div', undefined, 'entry-body');
      body.append(el('div', entry.title, 'entry-title'));
      body.append(el('div', entry.brandTitle, 'muted'));
      const opts = rowOptions(entry.brand);
      if (opts) body.append(slotEditor(config, slotTarget(entry), opts.onChanged));
      row.append(body);
      list.append(row);
    }
    const brands = [...new Set(data.unscheduled.map((e) => e.brand))];
    const actions = el('div', undefined, 'actions');
    for (const brand of brands) {
      const a = link(`#/s/${brand}/slots`, `Plan ${brand}`);
      a.className = 'button secondary';
      actions.append(a);
    }
    const body = el('div');
    body.append(list, actions);
    sections.push(card('No slot yet', body, 'Nothing is ever uploaded without a slot.'));
  }

  const brandLinks = el('div', undefined, 'actions');
  for (const brand of data.brands) {
    const a = link(`#/s/${brand.brand}/slots`, '');
    a.className = 'button secondary';
    a.append(
      brandIcon(config, { show: brand.brand, title: brand.title, iconKey: brand.iconKey }, 18),
    );
    a.append(el('span', `${brand.title} slots`));
    brandLinks.append(a);
  }
  sections.push(card('Slot scores', brandLinks, 'Which publish times have worked, per brand.'));

  app.replaceChildren(...sections);
}

/** A plan waiting to be taken, offered wherever it is relevant. */
function planOffer(plan: PendingPlan) {
  const body = el('div');
  body.append(
    el(
      'p',
      `${plan.items} item${plan.items === 1 ? '' : 's'} proposed for ${plan.brand}, from ${new Date(plan.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. Nothing is scheduled until you take it.`,
    ),
  );
  const actions = el('div', undefined, 'actions');
  const review = link(`#/s/${plan.brand}/slots?plan=${plan.planId}`, 'Review it');
  review.className = 'button';
  actions.append(review);
  body.append(actions);
  return card('A plan is waiting', body);
}

function heatmap(grid: HeatCell[]) {
  const wrap = el('div', undefined, 'heatmap');
  const table = el('table', undefined, 'heat');
  const head = table.createTHead().insertRow();
  head.append(el('th', ''));
  for (let hour = 0; hour < 24; hour++) {
    head.append(el('th', hour % 3 === 0 ? String(hour) : ''));
  }
  const body = table.createTBody();
  for (let day = 0; day < 7; day++) {
    const tr = body.insertRow();
    tr.append(el('th', DAY_NAMES[day]!));
    for (const cell of grid.filter((c) => c.day === day).sort((a, b) => a.hour - b.hour)) {
      const td = tr.insertCell();
      td.className = cell.level === null ? 'heat-cell empty' : `heat-cell l${cell.level}`;
      td.title = cell.title;
      td.setAttribute('aria-label', cell.title);
    }
  }
  wrap.append(scroller(table));
  const legend = el('div', undefined, 'legend');
  legend.append(el('span', 'weaker', 'muted'));
  for (let l = 0; l < 5; l++) legend.append(el('span', '', `swatch l${l}`));
  legend.append(el('span', 'stronger', 'muted'));
  legend.append(el('span', '· blank: never tried', 'muted'));
  wrap.append(legend);
  return wrap;
}

function planDetail(plan: SchedulePlan, onApprove?: () => void) {
  const body = el('div');
  body.append(
    el(
      'p',
      `${plan.perWeek} a week, ${plan.minGapHours}h apart, in ${plan.zone}. Scored on ${plan.samples} past video${plan.samples === 1 ? '' : 's'}.`,
      'muted',
    ),
  );
  for (const warning of plan.warnings) body.append(el('p', warning, 'warn'));

  const table = el('table', undefined, 'episodes');
  const head = table.createTHead().insertRow();
  for (const h of ['Goes live', 'Slot', 'Score', 'Item', 'Why']) head.append(el('th', h));
  const rows = table.createTBody();
  for (const a of plan.assignments) {
    const tr = rows.insertRow();
    tr.insertCell().textContent = new Date(a.publishAt).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    tr.insertCell().textContent = a.slotLabel;
    const score = tr.insertCell();
    score.className = 'num';
    score.textContent = a.score.toFixed(2);
    tr.insertCell().textContent = a.title;
    const why = tr.insertCell();
    why.className = 'muted';
    why.textContent = a.explore ? `${a.reason} (testing)` : a.reason;
  }
  body.append(scroller(table));

  for (const u of plan.unplaced) body.append(el('p', `${u.title}: ${u.reason}`, 'warn'));

  if (plan.approvedAt) {
    body.append(el('p', `Approved ${new Date(plan.approvedAt).toLocaleString('en-US')}.`, 'muted'));
  } else if (onApprove) {
    const actions = el('div', undefined, 'actions');
    const button = el('button', 'Approve this plan');
    button.className = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Approving…';
      onApprove();
    });
    actions.append(button);
    body.append(actions);
    body.append(
      el(
        'p',
        'Approving puts these times on the content. Nothing uploads now: each one goes to YouTube a few days before its slot.',
        'muted',
      ),
    );
  }
  return body;
}

/** A brand's slot scores, its plans, and the one button that takes a plan. */
export async function slotsView(
  app: HTMLElement,
  config: RuntimeConfig,
  brand: string,
  planId?: string,
) {
  const [scores, plans] = await Promise.all([
    get<SlotScoresResponse>(config, `/schedule/${brand}/slots`),
    get<PlansResponse>(config, `/schedule/${brand}/plans`),
  ]);

  const back = link('#/schedule', '← Schedule');
  back.className = 'back';
  const sections: HTMLElement[] = [back, el('h1', `${brand}: publish times`)];
  sections.push(
    el(
      'p',
      scores.samples
        ? `Scored on ${scores.samples} past video${scores.samples === 1 ? '' : 's'}, by the day and hour each went out, in ${scores.zone}.`
        : `No settled history for this brand yet, so every slot below is the general peak-time prior. Scores become real once videos have been out three days.`,
      'muted',
    ),
  );
  if (scores.fellBackToAllFormats) {
    sections.push(
      el(
        'p',
        'Too few Shorts to score on their own, so long-form history is included. Expect this to shift as Shorts build up.',
        'warn',
      ),
    );
  }
  sections.push(
    card(
      'The week',
      heatmap(heatGrid(scores)),
      'Built from each video’s first 72 hours: views, how much got watched, and subscribers won.',
    ),
  );

  const chosen = planId ? plans.plans.find((p) => p.planId === planId) : plans.plans[0];
  const rerender = () => slotsView(app, config, brand, planId);

  if (chosen) {
    const approve = chosen.approvedAt
      ? undefined
      : async () => {
          try {
            const result = await post<ApprovalResponse>(
              config,
              `/schedule/${brand}/plans/${chosen.planId}/approve`,
              {},
            );
            // Redrawn first, then told: a re-render replaces everything in
            // the page, so a notice added before it would simply vanish.
            await rerender();
            const count = result.applied.length;
            app.prepend(el('p', `Scheduled ${count} item${count === 1 ? '' : 's'}.`, 'notice'));
            for (const skipped of result.skipped) {
              app.prepend(el('p', `${skipped.id}: ${skipped.reason}`, 'warn'));
            }
          } catch (err) {
            app.prepend(el('p', err instanceof Error ? err.message : String(err), 'error'));
          }
        };
    sections.push(
      card(
        chosen.approvedAt ? `Plan ${chosen.planId}` : 'Proposed plan',
        planDetail(chosen, approve),
        chosen.approvedAt ? undefined : 'Nothing is scheduled until you approve it.',
      ),
    );
  }

  // A plan leaves settled slots alone unless asked: re-placing what is
  // already scheduled is a decision, not a default.
  const replan = el('input');
  replan.type = 'checkbox';
  const replanLabel = el('label', undefined, 'inline');
  replanLabel.append(replan, ' Move slots that are already set, including uploaded clips');

  const count = (placeholder: string) => {
    const i = el('input');
    i.type = 'number';
    i.min = '1';
    i.step = '1';
    i.inputMode = 'numeric';
    i.placeholder = placeholder;
    return i;
  };
  const weeks = count('6');
  const perWeek = count('3');
  const numbers = el('div', undefined, 'field-row');
  numbers.append(field('Weeks', weeks), field('Per week', perWeek));

  const build = el('button', 'Propose a plan');
  build.className = 'button';
  build.addEventListener('click', async () => {
    build.disabled = true;
    build.textContent = 'Planning…';
    const whole = (input: HTMLInputElement) =>
      input.value && Number.isInteger(Number(input.value)) ? Number(input.value) : undefined;
    try {
      const plan = await post<SchedulePlan>(config, `/schedule/${brand}/plans`, {
        replan: replan.checked || undefined,
        weeks: whole(weeks),
        perWeek: whole(perWeek),
      });
      // Changing the hash is what redraws the page. Re-rendering here as
      // well would race that, and the loser could show the older plan.
      location.hash = `#/s/${brand}/slots?plan=${plan.planId}`;
    } catch (err) {
      app.prepend(el('p', err instanceof Error ? err.message : String(err), 'error'));
      build.disabled = false;
      build.textContent = 'Propose a plan';
    }
  });
  const what = el('p', undefined, 'muted');
  const describe = () => {
    what.textContent = replan.checked
      ? 'Re-places everything for this channel, settled slots included. Approving writes the new times; anything already uploaded to YouTube has its release time moved there, and is not uploaded again.'
      : 'Builds a schedule for everything with no slot yet, best-scoring times first, with a share kept for slots nothing has been tried in.';
  };
  describe();
  replan.addEventListener('change', describe);

  const buildBox = el('div');
  buildBox.append(replanLabel, numbers, build, what);
  sections.push(card('Plan the next few weeks', buildBox));

  const older = plans.plans.filter((p) => p.planId !== chosen?.planId);
  if (older.length) {
    const list = el('ul', undefined, 'entries');
    for (const p of older.slice(0, 10)) {
      const li = el('li', undefined, 'entry');
      li.append(el('span', p.approvedAt ? 'taken' : 'open', 'entry-time'));
      const body = el('div', undefined, 'entry-body');
      body.append(
        link(
          `#/s/${brand}/slots?plan=${p.planId}`,
          `${p.planId} — ${p.assignments.length} item(s)`,
        ),
      );
      body.append(el('div', new Date(p.createdAt).toLocaleString('en-US'), 'muted'));
      li.append(body);
      list.append(li);
    }
    sections.push(card('Earlier plans', list));
  }

  app.replaceChildren(...sections);
}
