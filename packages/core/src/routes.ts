/**
 * The dashboard API's surface, in one list.
 *
 * Every path the browser asks for, every route the HTTP API deploys, and
 * every path builder the dashboard calls come from the table below. They
 * used to be three hand-kept lists, and they drifted: a handler shipped
 * with no route in front of it, and the browser got API Gateway's own 404.
 * That 404 carries no CORS headers, so `fetch` rejects before anything can
 * read the status — the dashboard showed a bare "NetworkError" and said
 * nothing about which call failed or why.
 *
 * So: adding an endpoint means adding a line here. The stack deploys what
 * this table says, and a path the table does not name cannot be built, so
 * the mismatch is a type error at the call site rather than a network
 * error in somebody's browser.
 *
 * This module is deliberately dependency-free: the dashboard imports it
 * into a browser bundle, and nothing else in `@darkrelay/core` should be
 * dragged along for it.
 */

/** Which Lambda answers. Each one is a router over its own path prefix. */
export type RouteOwner = 'reader' | 'uploads' | 'planner' | 'brandWrites';

export type RouteMethod = 'GET' | 'POST';

export interface Route {
  readonly owner: RouteOwner;
  readonly method: RouteMethod;
  /** Path template. `{name}` marks a single-segment parameter. */
  readonly path: string;
  /**
   * The route key that carries this path, where a wildcard already covers
   * it. The reader's own paths sit behind `/brands/{proxy+}`, because
   * replacing a deployed `{proxy+}` with the paths under it cannot be done
   * in one update: API Gateway refuses a route whose variable sits at the
   * same level as a greedy one, and CloudFormation adds the new routes
   * before it removes the old. A wildcard is no loss here — it is still a
   * route, so its 404 carries the CORS headers that make it readable.
   */
  readonly route?: string;
}

/**
 * Everything the dashboard may call, keyed by the name it calls it by.
 *
 * `/shows` and `/brands` are the same tree under two names. Which spelling
 * appears here is simply which one the dashboard asks for today; the other
 * is deployed alongside it below, so a browser holding an older build keeps
 * working across a deploy.
 */
export const API = {
  /** Who the caller is and what they may do. */
  me: { owner: 'uploads', method: 'GET', path: '/me' },

  /** Every brand the caller can see, with the last ingestion run. */
  brands: { owner: 'reader', method: 'GET', path: '/shows' },
  /** One brand: its series, episodes, videos and outlets. */
  brand: {
    owner: 'reader',
    method: 'GET',
    path: '/brands/{brand}',
    route: '/brands/{proxy+}',
  },
  episode: {
    owner: 'reader',
    method: 'GET',
    path: '/brands/{brand}/episodes/{episodeId}',
    route: '/brands/{proxy+}',
  },
  video: {
    owner: 'reader',
    method: 'GET',
    path: '/brands/{brand}/videos/{videoId}',
    route: '/brands/{proxy+}',
  },
  outlet: {
    owner: 'reader',
    method: 'GET',
    path: '/brands/{brand}/outlets/{outletId}',
    route: '/brands/{proxy+}',
  },

  /** A brand's icon. Needs `uploader` for that brand, checked in the router. */
  brandIcon: { owner: 'brandWrites', method: 'POST', path: '/brands/{brand}/icon' },

  /** Episode bundles: open one, send its parts, then finish it. */
  createUpload: { owner: 'uploads', method: 'POST', path: '/shows/{show}/uploads' },
  uploadStatus: { owner: 'uploads', method: 'GET', path: '/shows/{show}/uploads/{bundleId}' },
  uploadAction: {
    owner: 'uploads',
    method: 'POST',
    path: '/shows/{show}/uploads/{bundleId}/{action}',
  },
  catalog: { owner: 'uploads', method: 'GET', path: '/shows/{show}/catalog' },
  episodeDetails: { owner: 'uploads', method: 'GET', path: '/shows/{show}/catalog/{episodeId}' },

  /** Shorts batches belong to a brand, not a feed: a channel needs no show.json. */
  shortsContext: { owner: 'uploads', method: 'GET', path: '/brands/{brand}/shorts' },
  createBatch: { owner: 'uploads', method: 'POST', path: '/brands/{brand}/shorts' },
  batchStatus: { owner: 'uploads', method: 'GET', path: '/brands/{brand}/shorts/{batchId}' },
  batchAction: {
    owner: 'uploads',
    method: 'POST',
    path: '/brands/{brand}/shorts/{batchId}/{action}',
  },

  /** The schedule: the calendar, the slot heatmap, plans, and moving one slot. */
  schedule: { owner: 'planner', method: 'GET', path: '/schedule' },
  slots: { owner: 'planner', method: 'GET', path: '/schedule/{brand}/slots' },
  plans: { owner: 'planner', method: 'GET', path: '/schedule/{brand}/plans' },
  createPlan: { owner: 'planner', method: 'POST', path: '/schedule/{brand}/plans' },
  plan: { owner: 'planner', method: 'GET', path: '/schedule/{brand}/plans/{planId}' },
  approvePlan: {
    owner: 'planner',
    method: 'POST',
    path: '/schedule/{brand}/plans/{planId}/approve',
  },
  /** Adopting videos the channel already holds, so the scheduler can see them. */
  adopt: { owner: 'planner', method: 'POST', path: '/schedule/{brand}/import' },
  /** Moving one item's slot, including one already uploaded to YouTube. */
  reschedule: { owner: 'planner', method: 'POST', path: '/schedule/{brand}/content/{contentId}' },
} as const satisfies Record<string, Route>;

export type EndpointName = keyof typeof API;

/**
 * Routes the API carries that the dashboard does not call by name: the
 * older `/shows` spelling of the same tree, kept because a tab left open
 * across a deploy is still running the previous build and still asking for
 * it. Removing one is a breaking change, not a cleanup.
 */
export const EXTRA_ROUTES: readonly Route[] = [
  { owner: 'reader', method: 'GET', path: '/brands' },
  { owner: 'reader', method: 'GET', path: '/shows/{proxy+}' },
  { owner: 'brandWrites', method: 'POST', path: '/shows/{brand}/icon' },
];

/** The route key one entry is served by: its own path, or the wildcard over it. */
export const routeKey = (r: Route): string => `${r.method} ${r.route ?? r.path}`;

/**
 * Every route key the HTTP API should carry, once. Several of the reader's
 * paths share one wildcard route, so this is shorter than the table above.
 */
export function deployedRoutes(): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  const declared: Route[] = [...Object.values(API), ...EXTRA_ROUTES];
  for (const r of declared) {
    const key = routeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner: r.owner, method: r.method, path: r.route ?? r.path });
  }
  return out;
}

/** The routes one Lambda answers, in a stable order. */
export function routesFor(owner: RouteOwner): Route[] {
  return deployedRoutes().filter((r) => r.owner === owner);
}

/**
 * Whether a route key template would actually carry a path — the check that
 * keeps a `route` override honest, since a wrong one would deploy a route
 * in front of nothing and leave the real path unreachable.
 */
export function routeCovers(template: string, path: string): boolean {
  const want = template.split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  for (const [i, segment] of want.entries()) {
    if (segment.endsWith('+}')) return got.length > i;
    if (got[i] === undefined) return false;
    if (!segment.startsWith('{') && segment !== got[i]) return false;
  }
  return want.length === got.length;
}

/** The parameter names in a path template, as a union of literals. */
type ParamsIn<P extends string> = P extends `${string}{${infer Name}}${infer Rest}`
  ? Name | ParamsIn<Rest>
  : never;

export type PathParams<K extends EndpointName> = {
  readonly [N in ParamsIn<(typeof API)[K]['path']>]: string;
};

/** No second argument for a path that takes no parameters. */
type PathArgs<K extends EndpointName> = [ParamsIn<(typeof API)[K]['path']>] extends [never]
  ? []
  : [params: PathParams<K>];

/**
 * The path for one endpoint, with its parameters filled in and escaped.
 *
 * Escaping is belt and braces — ids are already restricted to slugs and
 * hex by the routers that read them — but a path is a URL, and building
 * one by concatenation is how a stray slash becomes a different route.
 */
export function apiPath<K extends EndpointName>(name: K, ...args: PathArgs<K>): string {
  const params = (args[0] ?? {}) as Record<string, string | undefined>;
  return API[name].path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined || value === '') {
      throw new Error(`${String(name)}: missing path parameter "${key}"`);
    }
    return encodeURIComponent(value);
  });
}
