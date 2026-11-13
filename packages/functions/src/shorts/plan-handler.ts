import {
  EpisodeManifest,
  accessFromGroups,
  groupsClaim,
  layout,
  type VideoFormat,
} from '@darkrelay/core';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryAll } from '../analytics/dynamo';
import { listBrands } from '../lib/brands';
import { S3Store } from '../lib/store';
import {
  approvePlan,
  listPlans,
  loadPlan,
  planContent,
  slotScores,
  type PlanRequest,
  type PlannerDeps,
} from './planner';
import type { Query } from './history';
import { route } from './schedule-api';

const store = new S3Store(process.env['MEDIA_BUCKET']!);
const table = process.env['TABLE_NAME']!;

/** Deployment defaults. A request may override any of them. */
const number = (name: string) => {
  const value = process.env[name];
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const defaults = {
  // Named `fallbackZone`, not `zone`: a brand that sets its own timezone
  // must keep it, and only a request may override that.
  fallbackZone: process.env['TIMEZONE'] || undefined,
  perWeek: number('PER_WEEK'),
  leadDays: number('LEAD_DAYS'),
};

const log = (message: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ message, ...data }));

const query: Query = (pk, sk) => {
  const values: Record<string, unknown> = { ':pk': pk };
  let condition = 'pk = :pk';
  if (sk?.between) {
    condition += ' AND sk BETWEEN :a AND :b';
    values[':a'] = sk.between[0];
    values[':b'] = sk.between[1];
  } else if (sk?.beginsWith) {
    condition += ' AND begins_with(sk, :p)';
    values[':p'] = sk.beginsWith;
  }
  return queryAll<Record<string, unknown>>({
    TableName: table,
    KeyConditionExpression: condition,
    ExpressionAttributeValues: values,
  });
};

const deps: PlannerDeps = {
  store,
  query,
  brands: () => listBrands(store, log),
  async episodes(show) {
    const keys = (await store.list(layout.episodesPrefix(show)))
      .map((o) => o.key)
      .filter((k) => k.endsWith('.json'));
    const episodes: EpisodeManifest[] = [];
    for (const key of keys) {
      const raw = await store.getText(key);
      if (raw === undefined) continue;
      const parsed = EpisodeManifest.safeParse(JSON.parse(raw));
      if (parsed.success) episodes.push(parsed.data);
    }
    return episodes;
  },
  now: () => new Date(),
  log,
};

export type PlanEvent =
  | { action: 'plan'; request: PlanRequest }
  | { action: 'approve'; brand: string; planId: string }
  | { action: 'show'; brand: string; planId: string }
  | { action: 'plans'; brand: string }
  | { action: 'slots'; brand: string; zone?: string; format?: VideoFormat; sinceDays?: number };

type HttpEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

const isHttp = (event: PlanEvent | HttpEvent): event is HttpEvent =>
  'requestContext' in event && !!(event as HttpEvent).requestContext?.http;

/**
 * The dashboard's requests. The same function serves them as serves the CLI,
 * because planning needs exactly one set of permissions — read the metrics,
 * read and write the catalog — and there is no reason to grant it twice.
 */
async function http(event: HttpEvent): Promise<APIGatewayProxyResultV2> {
  const access = accessFromGroups(
    groupsClaim(event.requestContext.authorizer.jwt.claims['cognito:groups']),
  );
  let body: unknown;
  try {
    body = event.body
      ? JSON.parse(
          event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body,
        )
      : undefined;
  } catch {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Body is not valid JSON' }),
    };
  }
  const res = await route(deps, {
    method: event.requestContext.http.method,
    path: event.rawPath,
    params: event.queryStringParameters ?? {},
    body,
    access,
  });
  return {
    statusCode: res.statusCode,
    // Never cached: a plan's state is the thing being looked at.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(res.body),
  };
}

/**
 * Planning, on demand only. There is no schedule on this function: a plan is
 * something a person asks for, reads, and approves. Nothing here uploads
 * anything, and nothing here is on the path of a feed or a download.
 */
export async function handler(event: PlanEvent | HttpEvent) {
  if (isHttp(event)) return http(event);
  return invoked(event);
}

async function invoked(event: PlanEvent) {
  switch (event.action) {
    case 'plan': {
      // The request wins where it says anything; undefined fields fall back
      // to the deployment's own settings.
      const request = Object.fromEntries(
        Object.entries(event.request).filter(([, v]) => v !== undefined),
      ) as PlanRequest;
      return planContent(deps, { ...defaults, ...request });
    }
    case 'approve':
      return approvePlan(deps, event.brand, event.planId);
    case 'show': {
      const plan = await loadPlan(store, event.brand, event.planId);
      if (!plan) throw new Error(`No plan "${event.planId}" for ${event.brand}`);
      return plan;
    }
    case 'plans':
      return listPlans(store, event.brand);
    case 'slots':
      return slotScores(deps, event.brand, {
        zone: event.zone,
        fallbackZone: defaults.fallbackZone,
        format: event.format,
        sinceDays: event.sinceDays,
      });
    default:
      throw new Error(`Unknown action "${(event as { action: string }).action}"`);
  }
}
