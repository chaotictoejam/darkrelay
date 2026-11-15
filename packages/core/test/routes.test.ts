import { describe, expect, it } from 'vitest';
import {
  API,
  EXTRA_ROUTES,
  apiPath,
  deployedRoutes,
  routeCovers,
  routeKey,
  routesFor,
} from '../src/routes';

describe('the API route table', () => {
  it('deploys each route key once', () => {
    const keys = deployedRoutes().map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every route to a Lambda that claims it', () => {
    const owned = (['reader', 'uploads', 'planner', 'brandWrites'] as const).flatMap((o) =>
      routesFor(o),
    );
    expect(owned.length).toBe(deployedRoutes().length);
  });

  it('starts every path at the root, with no trailing slash', () => {
    for (const { path } of [...Object.values(API), ...EXTRA_ROUTES]) {
      expect(path, path).toMatch(/^\/[^/]/);
      expect(path, path).not.toMatch(/\/$/);
    }
  });

  /**
   * A `route` override that does not actually carry its path would deploy a
   * route in front of nothing and leave the real path unreachable — the same
   * CORS-less 404 the table exists to prevent, just harder to spot.
   */
  it('puts every endpoint behind a route that carries it', () => {
    for (const [name, route] of Object.entries(API)) {
      const key = routeKey(route);
      const deployed = deployedRoutes().find((r) => `${r.method} ${r.path}` === key);
      expect(deployed, `${name}: nothing deploys ${key}`).toBeDefined();
      expect(routeCovers(deployed!.path, route.path), `${name}: ${key} misses ${route.path}`).toBe(
        true,
      );
    }
  });

  it('keeps the wildcards to the reader, which routes by path itself', () => {
    for (const r of deployedRoutes()) {
      if (r.path.includes('+}')) expect(r.owner, r.path).toBe('reader');
    }
  });
});

describe('routeCovers', () => {
  it('matches a path against its own template', () => {
    expect(routeCovers('/brands/{brand}', '/brands/{brand}')).toBe(true);
    expect(routeCovers('/brands/{brand}', '/brands/{brand}/videos/{videoId}')).toBe(false);
    expect(routeCovers('/schedule/{brand}/plans', '/schedule/{brand}/slots')).toBe(false);
  });

  it('lets a greedy template take everything below it, but not the level itself', () => {
    expect(routeCovers('/brands/{proxy+}', '/brands/{brand}')).toBe(true);
    expect(routeCovers('/brands/{proxy+}', '/brands/{brand}/videos/{videoId}')).toBe(true);
    expect(routeCovers('/brands/{proxy+}', '/brands')).toBe(false);
    expect(routeCovers('/brands/{proxy+}', '/schedule/{brand}/slots')).toBe(false);
  });
});

describe('apiPath', () => {
  it('fills parameters in and leaves nothing behind', () => {
    expect(apiPath('schedule')).toBe('/schedule');
    expect(apiPath('slots', { brand: 'chaoticcommits' })).toBe('/schedule/chaoticcommits/slots');
    expect(apiPath('reschedule', { brand: 'cc', contentId: 'short-0001' })).toBe(
      '/schedule/cc/content/short-0001',
    );
    expect(apiPath('uploadAction', { show: 'cc', bundleId: 'b1', action: 'parts' })).toBe(
      '/shows/cc/uploads/b1/parts',
    );
  });

  it('builds a real path for every endpoint it offers', () => {
    for (const name of Object.keys(API) as (keyof typeof API)[]) {
      const params = Object.fromEntries(
        [...API[name].path.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, 'x']),
      );
      const built = apiPath(name, params as never);
      expect(built, name).not.toContain('{');
    }
  });

  /**
   * Ids reaching here are already slugs or hex, so this is belt and braces —
   * but a path is a URL, and a stray slash in a parameter would silently
   * address a different route rather than fail.
   */
  it('escapes a parameter rather than letting it add segments', () => {
    expect(apiPath('brand', { brand: 'a/b' })).toBe('/brands/a%2Fb');
  });

  it('refuses to build a path with a parameter missing', () => {
    expect(() => apiPath('brand', { brand: '' })).toThrow(/missing path parameter "brand"/);
  });
});
