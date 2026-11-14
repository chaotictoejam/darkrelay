import {
  DEFAULT_LEAD_DAYS,
  DEFAULT_ZONE,
  SchedulePlan,
  buildPlan,
  episodeId as idOf,
  feedShow,
  layout,
  newBundleId,
  outletsOfKind,
  publicationFor,
  scoreSlots,
  type BrandConfig,
  type ContentItem,
  type EpisodeManifest,
  type PlanItem,
  type SlotScores,
  type VideoFormat,
} from '@darkrelay/core';
import type { Store } from '../lib/store';
import { loadHistory, type Query } from './history';
import { listContent } from './upload';

/**
 * Planning, as a step of its own. It reads the brand's history out of the
 * metrics table, scores the week, lays out a schedule, and writes it down.
 * It never writes a publish time onto content and never calls YouTube —
 * approving the plan is what does that, and it is a separate call, because a
 * schedule nobody looked at is not a schedule anybody wanted.
 */

export interface PlannerDeps {
  store: Store;
  /** Metrics table reader. Read-only: planning never writes analytics. */
  query: Query;
  brands(): Promise<BrandConfig[]>;
  episodes(show: string): Promise<EpisodeManifest[]>;
  /**
   * Asks the Shorts worker to act on one item now, rather than at the next
   * hourly sweep. Moving the slot of something already on YouTube is the
   * case that needs it: the new time is only real once the platform has it.
   * Where it is missing, the sweep picks the change up within the hour.
   */
  syncNow?(event: { brand: string; id: string; outlet: string }): Promise<void>;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface PlanRequest {
  brand: string;
  outlet?: string;
  /** Overrides everything, including the brand's own timezone. */
  zone?: string;
  /** The deployment's zone, used only where the brand names none. */
  fallbackZone?: string;
  weeks?: number;
  perWeek?: number;
  minGapHours?: number;
  days?: number[];
  hours?: number[];
  exploreShare?: number;
  /** Ignore history older than this when scoring. */
  sinceDays?: number;
  /** Earliest slot is now plus this, so the sweep has time to upload. */
  leadDays?: number;
  /** Replace the slots of content that already has one. */
  replan?: boolean;
}

async function brandOf(deps: PlannerDeps, slug: string): Promise<BrandConfig> {
  const brand = (await deps.brands()).find((b) => b.slug === slug);
  if (!brand) throw new Error(`No brand "${slug}" in this deployment`);
  return brand;
}

function outletOf(brand: BrandConfig, id?: string) {
  const channels = outletsOfKind(brand, 'youtube');
  const outlet = id ? channels.find((c) => c.id === id) : channels[0];
  if (!outlet) {
    throw new Error(
      id
        ? `${brand.slug} has no YouTube outlet "${id}"`
        : `${brand.slug} has no YouTube outlet to plan for`,
    );
  }
  return outlet;
}

/**
 * The slot scores for one brand, as the planner and the dashboard heatmap
 * both see them.
 */
export async function slotScores(
  deps: PlannerDeps,
  slug: string,
  opts: {
    zone?: string;
    fallbackZone?: string;
    format?: VideoFormat;
    sinceDays?: number;
  } = {},
): Promise<SlotScores> {
  const brand = await brandOf(deps, slug);
  const history = await loadHistory(deps, brand.slug);
  return scoreSlots(history, {
    zone: opts.zone ?? brand.timezone ?? opts.fallbackZone ?? DEFAULT_ZONE,
    format: opts.format,
    sinceDays: opts.sinceDays,
    now: deps.now(),
  });
}

/**
 * The earliest each Short may go out. A clip of an episode must not appear
 * before the episode it is clipped from: it would spoil something nobody
 * has heard yet, and it would send its own audience to a feed with nothing
 * in it.
 */
async function parentDates(
  deps: PlannerDeps,
  brand: BrandConfig,
  items: ContentItem[],
): Promise<Map<string, string>> {
  const wanted = new Set(items.map((i) => i.parentId).filter((p): p is string => !!p));
  if (!wanted.size) return new Map();
  const show = feedShow(brand);
  if (!show) return new Map();
  const dates = new Map<string, string>();
  for (const episode of await deps.episodes(show)) {
    const id = idOf(episode.guid);
    if (wanted.has(id)) dates.set(id, episode.pubDate);
  }
  return dates;
}

/** Shorts are scored against Shorts; a long video against long-form. */
function formatOf(items: ContentItem[]): VideoFormat | undefined {
  const kinds = new Set(items.map((i) => i.kind));
  if (kinds.size !== 1) return undefined;
  return kinds.has('short') ? 'short' : 'long';
}

/**
 * Builds a plan and stores it. Content that already has a slot is reported
 * but left alone unless `replan` is set, and anything already published is
 * never touched at all.
 */
export async function planContent(deps: PlannerDeps, req: PlanRequest): Promise<SchedulePlan> {
  const now = deps.now();
  const brand = await brandOf(deps, req.brand);
  const outlet = outletOf(brand, req.outlet);
  // A brand's own clock beats the deployment's: its audience is its own.
  const zone = req.zone ?? brand.timezone ?? req.fallbackZone ?? DEFAULT_ZONE;

  const all = await listContent(deps.store, brand.slug);
  // Content for this channel, that is not already out.
  const items = all.filter((i) => {
    const publication = publicationFor(i, outlet.id);
    if (publication?.state === 'published') return false;
    return !i.publications.length || i.publications.some((p) => p.outlet === outlet.id);
  });

  const parents = await parentDates(deps, brand, items);
  const history = await loadHistory(deps, brand.slug);
  const scores = scoreSlots(history, {
    zone,
    format: formatOf(items),
    sinceDays: req.sinceDays,
    now,
  });

  const leadDays = req.leadDays ?? DEFAULT_LEAD_DAYS;
  const from = new Date(now.getTime() + leadDays * 86_400_000);
  const planItems: PlanItem[] = [...items]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
    .map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      publishAt: i.publishAt,
      notBefore: i.parentId ? parents.get(i.parentId) : undefined,
    }));

  const plan = buildPlan(planItems, scores, {
    planId: newBundleId(now),
    brand: brand.slug,
    outlet: outlet.id,
    zone,
    from,
    weeks: req.weeks,
    perWeek: req.perWeek,
    minGapHours: req.minGapHours,
    days: req.days,
    hours: req.hours,
    exploreShare: req.exploreShare,
    replan: req.replan,
    now,
  });

  await deps.store.put(layout.contentPlan(brand.slug, plan.planId), JSON.stringify(plan, null, 2), {
    contentType: 'application/json',
  });
  deps.log('Built a schedule plan', {
    brand: brand.slug,
    outlet: outlet.id,
    planId: plan.planId,
    assigned: plan.assignments.length,
    unplaced: plan.unplaced.length,
    samples: plan.samples,
  });
  return plan;
}

export async function loadPlan(
  store: Store,
  brand: string,
  planId: string,
): Promise<SchedulePlan | undefined> {
  const raw = await store.getText(layout.contentPlan(brand, planId));
  if (raw === undefined) return undefined;
  const parsed = SchedulePlan.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

/** Every plan a brand has, newest first. */
export async function listPlans(store: Store, brand: string): Promise<SchedulePlan[]> {
  const plans: SchedulePlan[] = [];
  for (const { key } of await store.list(layout.plansPrefix(brand))) {
    if (!key.endsWith('.json')) continue;
    const raw = await store.getText(key);
    if (raw === undefined) continue;
    const parsed = SchedulePlan.safeParse(JSON.parse(raw));
    if (parsed.success) plans.push(parsed.data);
  }
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ApprovalResult {
  plan: SchedulePlan;
  applied: { id: string; publishAt: string }[];
  skipped: { id: string; reason: string }[];
}

/**
 * Approval: the one step that writes a plan's times onto content. Even then
 * nothing is uploaded here — the hourly sweep picks each item up when its
 * slot comes within the lead time, exactly as it does for a slot set by
 * hand.
 */
export async function approvePlan(
  deps: PlannerDeps,
  brandSlug: string,
  planId: string,
): Promise<ApprovalResult> {
  const now = deps.now();
  const plan = await loadPlan(deps.store, brandSlug, planId);
  if (!plan) throw new Error(`No plan "${planId}" for ${brandSlug}`);
  if (plan.approvedAt) {
    throw new Error(
      `Plan ${planId} was already approved at ${plan.approvedAt}. Build a new one to change the schedule.`,
    );
  }

  const applied: { id: string; publishAt: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const assignment of plan.assignments) {
    const key = layout.contentItem(plan.brand, assignment.id);
    const raw = await deps.store.getText(key);
    if (raw === undefined) {
      skipped.push({ id: assignment.id, reason: 'the content is gone' });
      continue;
    }
    const item = JSON.parse(raw) as ContentItem;
    const publication = publicationFor(item, plan.outlet);
    if (publication?.state === 'published') {
      skipped.push({ id: assignment.id, reason: 'already published' });
      continue;
    }
    const updated: ContentItem = {
      ...item,
      publishAt: assignment.publishAt,
      // A publication already sent to YouTube keeps its id and its state; the
      // sweep sees the new time and moves it there.
      publications: item.publications.map((p) =>
        p.outlet === plan.outlet
          ? { ...p, publishAt: assignment.publishAt, updatedAt: now.toISOString() }
          : p,
      ),
      updatedAt: now.toISOString(),
    };
    await deps.store.put(key, JSON.stringify(updated, null, 2), {
      contentType: 'application/json',
    });
    applied.push({ id: assignment.id, publishAt: assignment.publishAt });
  }

  const approved: SchedulePlan = {
    ...plan,
    approvedAt: now.toISOString(),
    applied,
  };
  await deps.store.put(
    layout.contentPlan(plan.brand, plan.planId),
    JSON.stringify(approved, null, 2),
    { contentType: 'application/json' },
  );
  deps.log('Approved a schedule plan', {
    brand: plan.brand,
    planId: plan.planId,
    applied: applied.length,
    skipped: skipped.length,
  });
  return { plan: approved, applied, skipped };
}

export interface RescheduleResult {
  id: string;
  title: string;
  publishAt: string;
  outlet?: string;
  state?: string;
  externalId?: string;
  /** True when the platform is being told the new time now, not at the sweep. */
  syncing: boolean;
  warnings: string[];
}

/**
 * Moves one item's slot, or releases it now. The same three steps as
 * `darkrelay shorts schedule`: write the new time on the content record,
 * leave a publication that is already out alone, and — if the video is
 * sitting on YouTube waiting for its old time — ask the worker to move it
 * there straight away instead of waiting for the sweep.
 *
 * An item with no slot gets one here, which is how something the planner
 * skipped is scheduled by hand.
 */
export async function rescheduleContent(
  deps: PlannerDeps,
  brandSlug: string,
  id: string,
  at: Date,
): Promise<RescheduleResult> {
  const now = deps.now();
  const key = layout.contentItem(brandSlug, id);
  const raw = await deps.store.getText(key);
  if (raw === undefined) throw new Error(`No content "${id}" for ${brandSlug}`);
  const item = JSON.parse(raw) as ContentItem;
  const publishAt = at.toISOString();
  const warnings: string[] = [];

  const updated: ContentItem = {
    ...item,
    publishAt,
    // A publication already out keeps its time: that release happened, and
    // a schedule cannot restate a fact about the world.
    publications: item.publications.map((p) =>
      p.state === 'published' ? p : { ...p, publishAt, updatedAt: now.toISOString() },
    ),
    updatedAt: now.toISOString(),
  };
  await deps.store.put(key, JSON.stringify(updated, null, 2), { contentType: 'application/json' });

  const publication = updated.publications[0];
  if (publication?.state === 'published') {
    warnings.push(
      'This one is already public on YouTube. Its slot here is updated, but the video stays where it is.',
    );
  }
  // Uploaded and waiting: the platform is holding the old time, so move it.
  const move =
    publication !== undefined &&
    publication.state !== 'published' &&
    publication.externalId !== undefined;
  if (move && deps.syncNow) {
    await deps.syncNow({ brand: brandSlug, id, outlet: publication.outlet });
  } else if (move) {
    warnings.push('YouTube is moved to the new time by the next hourly sweep.');
  }

  deps.log('Rescheduled content', { brand: brandSlug, id, publishAt, moved: move });
  return {
    id,
    title: updated.title,
    publishAt,
    outlet: publication?.outlet,
    state: publication?.state,
    externalId: publication?.externalId,
    syncing: move && deps.syncNow !== undefined,
    warnings,
  };
}
