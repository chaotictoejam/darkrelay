import { rebuildFeed, type PublisherDeps } from './feed';
import { publishBundle } from './publish';

const SAFE = '[A-Za-z0-9][A-Za-z0-9._-]*';
const INBOX = new RegExp(`^inbox/(${SAFE})/(${SAFE})/episode\\.json$`);
const SHOW = new RegExp(`^catalog/(${SAFE})/show\\.json$`);
const REQUEST = new RegExp(`^requests/(${SAFE})/rebuild$`);

/** Routes an S3 object-created key to the right action. Unknown keys are ignored. */
export async function routeObjectCreated(deps: PublisherDeps, key: string) {
  let m = INBOX.exec(key);
  if (m) return publishBundle(deps, m[1]!, m[2]!);
  m = SHOW.exec(key);
  if (m) return rebuildFeed(deps, m[1]!);
  m = REQUEST.exec(key);
  if (m) {
    const result = await rebuildFeed(deps, m[1]!);
    await deps.store.delete([key]);
    return result;
  }
  deps.log('Ignoring key', { key });
  return undefined;
}

/**
 * Hourly sweep: rebuilds every show so scheduled episodes appear once their
 * pubDate passes. Unchanged feeds are not rewritten or invalidated.
 */
export async function rebuildAll(deps: PublisherDeps) {
  const shows = (await deps.store.list('catalog/'))
    .map((o) => SHOW.exec(o.key)?.[1])
    .filter((s): s is string => s !== undefined);
  const results: Record<string, string> = {};
  for (const slug of shows) {
    results[slug] = (await rebuildFeed(deps, slug)).status;
  }
  return results;
}
