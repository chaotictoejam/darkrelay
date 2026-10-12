import { rebuildFeed, type PublisherDeps } from './feed';
import { PROCESSED_FILE, TranscodeJob, type ProcessedResult } from '@darkrelay/core';
import { publishBundle } from './publish';

const SAFE = '[A-Za-z0-9][A-Za-z0-9._-]*';
const INBOX = new RegExp(`^inbox/(${SAFE})/(${SAFE})/(?:episode|processed)\\.json$`);
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

export interface StoppedTask {
  stoppedReason?: string;
  stopCode?: string;
  containers?: { exitCode?: number }[];
  overrides?: { containerOverrides?: { environment?: { name: string; value: string }[] }[] };
}

/**
 * A transcoder task stopped. If it finished, processed.json is already in
 * the bundle and has resumed publishing. Otherwise (a Spot interruption, a
 * crash) retry once on regular Fargate, then give up and reject the bundle.
 */
export async function onTranscoderStopped(deps: PublisherDeps, task: StoppedTask) {
  const env = task.overrides?.containerOverrides?.[0]?.environment ?? [];
  const raw = env.find((e) => e.name === 'JOB')?.value;
  if (!raw) return undefined;
  const job = TranscodeJob.parse(JSON.parse(raw));
  if ((await deps.store.head(job.bundlePrefix + PROCESSED_FILE)) !== undefined) return 'finished';

  const reason = task.stoppedReason ?? task.stopCode ?? 'unknown';
  if (job.attempt < 2) {
    deps.log('Transcoder stopped early; retrying on regular Fargate', {
      bundle: job.bundlePrefix,
      reason,
    });
    await deps.startTranscode({ ...job, attempt: job.attempt + 1 }, { spot: false });
    return 'retried';
  }
  const failed: ProcessedResult = {
    ok: false,
    error: `Transcoder stopped twice without finishing (${reason})`,
    finishedAt: deps.now().toISOString(),
  };
  // Writing processed.json routes the bundle back through publishing, which rejects it.
  await deps.store.put(job.bundlePrefix + PROCESSED_FILE, JSON.stringify(failed), {
    contentType: 'application/json',
  });
  return 'failed';
}
