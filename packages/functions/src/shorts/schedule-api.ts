import {
  CONTENT_ID,
  SLUG,
  VIDEO_FORMATS,
  canUpload,
  canView,
  publicationFor,
  type Access,
  type BrandConfig,
  type ContentItem,
  type SchedulePlan,
  type VideoFormat,
} from '@darkrelay/core';
import { z } from 'zod';
import {
  approvePlan,
  listPlans,
  loadPlan,
  planContent,
  rescheduleContent,
  slotScores,
  type PlannerDeps,
} from './planner';
import { listContent } from './upload';

/**
 * The dashboard's view of the schedule. Reading is one thing and approving
 * is another: every GET here needs only `viewer` on the brand, and the two
 * POSTs — build a plan, approve a plan — need `uploader`, because approving
 * is what eventually puts a video on a channel.
 */

export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

export interface ScheduleRequest {
  method: string;
  path: string;
  params: Record<string, string | undefined>;
  body?: unknown;
  access: Access;
}

const error = (statusCode: number, message: string): ApiResponse => ({
  statusCode,
  body: { error: message },
});

const FORBIDDEN = error(403, "You don't have access to this brand");
const NOT_YOURS = error(403, 'You need the uploader role on this brand to schedule anything');
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A new slot for one item: a time with a zone, or "now" to release it. The
 * same two forms `--at` takes, so a slot moved in the dashboard and a slot
 * moved from the CLI mean the same thing.
 */
const SlotBody = z
  .object({ at: z.union([z.literal('now'), z.iso.datetime({ offset: true })]) })
  .strict();

/** What a dashboard may ask for when building a plan. */
const PlanBody = z
  .object({
    outlet: z.string().max(40).optional(),
    zone: z.string().max(60).optional(),
    weeks: z.number().int().min(1).max(26).optional(),
    perWeek: z.number().int().min(1).max(21).optional(),
    minGapHours: z.number().min(0).max(336).optional(),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    hours: z.array(z.number().int().min(0).max(23)).max(24).optional(),
    exploreShare: z.number().min(0).max(1).optional(),
    sinceDays: z.number().int().min(1).max(3650).optional(),
    leadDays: z.number().int().min(0).max(30).optional(),
    replan: z.boolean().optional(),
  })
  .strict();

/** One piece of content as a calendar entry. */
export interface ScheduleEntry {
  brand: string;
  brandTitle: string;
  id: string;
  title: string;
  kind: string;
  publishAt?: string;
  outlet?: string;
  /** Where it stands on that outlet: planned, scheduled, published, failed. */
  state?: string;
  externalId?: string;
  error?: string;
  warnings?: string[];
  parentId?: string;
}

function entry(brand: BrandConfig, item: ContentItem): ScheduleEntry {
  const publication = item.publications[0];
  const forOutlet = publication ? publicationFor(item, publication.outlet) : undefined;
  return {
    brand: brand.slug,
    brandTitle: brand.name,
    id: item.id,
    title: item.title,
    kind: item.kind,
    publishAt: item.publishAt,
    outlet: forOutlet?.outlet,
    state: forOutlet?.state,
    externalId: forOutlet?.externalId,
    error: forOutlet?.error,
    warnings: forOutlet?.warnings?.length ? forOutlet.warnings : undefined,
    parentId: item.parentId,
  };
}

/** Plans nobody has taken yet, newest first: the calendar offers these. */
function pending(plans: SchedulePlan[]) {
  return plans
    .filter((p) => !p.approvedAt && p.assignments.length)
    .slice(0, 5)
    .map((p) => ({
      brand: p.brand,
      planId: p.planId,
      createdAt: p.createdAt,
      items: p.assignments.length,
      from: p.from,
      to: p.to,
      firstAt: p.assignments[0]?.publishAt,
    }));
}

/**
 * Everything coming up, across every brand the caller can see. Content only:
 * an episode's release is owned by its feed and finding future ones means
 * reading every manifest, which is too much for a page load.
 */
async function upcoming(deps: PlannerDeps, access: Access, now: Date): Promise<ApiResponse> {
  const visible = (await deps.brands()).filter((b) => canView(access, b.slug));
  // Yesterday, so something that went out hours ago is still on the calendar.
  const floor = now.getTime() - 86_400_000;
  const scheduled: ScheduleEntry[] = [];
  const unscheduled: ScheduleEntry[] = [];
  const plans: ReturnType<typeof pending> = [];

  for (const brand of visible) {
    const items = await listContent(deps.store, brand.slug);
    for (const item of items) {
      const row = entry(brand, item);
      if (!item.publishAt) unscheduled.push(row);
      else if (Date.parse(item.publishAt) >= floor) scheduled.push(row);
    }
    if (canUpload(access, brand.slug)) {
      plans.push(...pending(await listPlans(deps.store, brand.slug)));
    }
  }

  return {
    statusCode: 200,
    body: {
      now: now.toISOString(),
      brands: visible.map((b) => ({
        brand: b.slug,
        title: b.name,
        // Same two fields the brand row carries, so the dashboard's icon
        // helper works here without knowing where the brand came from.
        iconKey: b.icon && 'key' in b.icon ? b.icon.key : undefined,
        iconUrl: b.icon && 'url' in b.icon ? b.icon.url : undefined,
        canSchedule: canUpload(access, b.slug),
      })),
      upcoming: scheduled.sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? '')),
      unscheduled: unscheduled.sort((a, b) => a.brand.localeCompare(b.brand)),
      plans: plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    },
  };
}

function formatParam(value: string | undefined): VideoFormat | undefined {
  return VIDEO_FORMATS.includes(value as VideoFormat) ? (value as VideoFormat) : undefined;
}

function numberParam(value: string | undefined): number | undefined {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Routes a schedule request. Mirrors the analytics API: a pure function over
 * its dependencies, so every rule below is testable without AWS.
 */
export async function route(deps: PlannerDeps, req: ScheduleRequest): Promise<ApiResponse> {
  const parts = req.path.split('/').filter(Boolean);
  if (parts[0] !== 'schedule') return error(404, 'Not found');

  if (parts.length === 1) {
    if (req.method !== 'GET') return error(405, 'Method not allowed');
    return upcoming(deps, req.access, deps.now());
  }

  const brand = parts[1]!;
  if (!SLUG.test(brand)) return error(400, 'Bad brand');
  if (!canView(req.access, brand)) return FORBIDDEN;

  try {
    if (parts.length === 3 && parts[2] === 'slots') {
      if (req.method !== 'GET') return error(405, 'Method not allowed');
      const scores = await slotScores(deps, brand, {
        zone: req.params['zone'],
        format: formatParam(req.params['format']),
        sinceDays: numberParam(req.params['since']),
      });
      return { statusCode: 200, body: scores };
    }

    // Moving one item's slot, including one already uploaded to YouTube: the
    // record is rewritten and the platform is told, which is why this needs
    // `uploader` and not just `viewer`.
    if (parts[2] === 'content') {
      if (parts.length !== 4) return error(404, 'Not found');
      if (req.method !== 'POST') return error(405, 'Method not allowed');
      if (!canUpload(req.access, brand)) return NOT_YOURS;
      const id = parts[3]!;
      if (!CONTENT_ID.test(id)) return error(400, 'Bad content id');
      const parsed = SlotBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return error(400, z.prettifyError(parsed.error).replace(/\n/g, '; '));
      }
      const at = parsed.data.at === 'now' ? deps.now() : new Date(parsed.data.at);
      return { statusCode: 200, body: await rescheduleContent(deps, brand, id, at) };
    }

    if (parts[2] !== 'plans') return error(404, 'Not found');

    if (parts.length === 3 && req.method === 'GET') {
      return { statusCode: 200, body: { brand, plans: await listPlans(deps.store, brand) } };
    }

    if (parts.length === 3 && req.method === 'POST') {
      if (!canUpload(req.access, brand)) return NOT_YOURS;
      const parsed = PlanBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return error(400, z.prettifyError(parsed.error).replace(/\n/g, '; '));
      }
      return { statusCode: 200, body: await planContent(deps, { brand, ...parsed.data }) };
    }

    const planId = parts[3];
    if (!planId || !PLAN_ID.test(planId)) return error(400, 'Bad plan id');

    if (parts.length === 4 && req.method === 'GET') {
      const plan = await loadPlan(deps.store, brand, planId);
      return plan
        ? { statusCode: 200, body: plan }
        : error(404, `No plan "${planId}" for ${brand}`);
    }

    if (parts.length === 5 && parts[4] === 'approve' && req.method === 'POST') {
      if (!canUpload(req.access, brand)) return NOT_YOURS;
      return { statusCode: 200, body: await approvePlan(deps, brand, planId) };
    }

    return error(404, 'Not found');
  } catch (e) {
    // A refusal from the planner is a bad request, not a crash: it means the
    // brand has no channel, or the plan was approved already.
    const message = e instanceof Error ? e.message : String(e);
    deps.log('Schedule request failed', { path: req.path, error: message });
    return error(400, message);
  }
}
