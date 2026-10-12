import { createHash } from 'node:crypto';
import {
  EpisodeManifest,
  ShowConfig,
  buildFeed,
  nextRelease,
  feedUrl,
  layout,
  publicKey,
  validateFeed,
  type Issue,
} from '@darkrelay/core';
import type { Store } from '../lib/store';

export interface PublisherDeps {
  store: Store;
  baseUrl: string;
  invalidate(paths: string[]): Promise<void>;
  notifyPodcastIndex(feedUrl: string): Promise<void>;
  /**
   * Arranges a rebuild of this show at `at` (the next scheduled release), or
   * cancels it when nothing is scheduled. Best effort: the hourly sweep is
   * the fallback.
   */
  scheduleRelease(show: string, at: Date | undefined): Promise<void>;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export type RebuildResult =
  | { status: 'written' | 'unchanged'; key: string; warnings: Issue[] }
  | { status: 'invalid'; errors: Issue[]; warnings: Issue[] }
  | { status: 'no-show' };

export const FEED_CACHE_CONTROL = 'public, max-age=300';
export const RELEASE_DELAY_MS = 5000;

export async function loadShow(store: Store, slug: string): Promise<ShowConfig | undefined> {
  const raw = await store.getText(layout.showConfig(slug));
  return raw === undefined ? undefined : ShowConfig.parse(JSON.parse(raw));
}

export async function loadEpisodes(deps: PublisherDeps, slug: string): Promise<EpisodeManifest[]> {
  const objects = await deps.store.list(layout.episodesPrefix(slug));
  const episodes: EpisodeManifest[] = [];
  for (const { key } of objects.filter((o) => o.key.endsWith('.json'))) {
    const raw = await deps.store.getText(key);
    if (raw === undefined) continue;
    const parsed = EpisodeManifest.safeParse(JSON.parse(raw));
    if (parsed.success) episodes.push(parsed.data);
    else deps.log('Skipping invalid episode manifest', { key, issues: parsed.error.issues });
  }
  return episodes;
}

/**
 * Rebuilds a show's feed from its manifests. A feed that fails validation is
 * never written: the previous feed stays live and the errors are saved next
 * to the show config.
 */
export async function rebuildFeed(deps: PublisherDeps, slug: string): Promise<RebuildResult> {
  const { store } = deps;
  const show = await loadShow(store, slug);
  if (!show) return { status: 'no-show' };

  const episodes = await loadEpisodes(deps, slug);
  const next = show.status === 'live' ? nextRelease(episodes, deps.now()) : undefined;
  // A few seconds late, so the release is unambiguously in the past when it fires.
  await deps
    .scheduleRelease(slug, next && new Date(next.getTime() + RELEASE_DELAY_MS))
    .catch((e: unknown) => deps.log('Could not schedule release', { slug, error: String(e) }));
  const xml = buildFeed({ show, episodes, baseUrl: deps.baseUrl, now: deps.now() });
  const { errors, warnings } = validateFeed(xml);
  if (errors.length > 0) {
    await store.put(layout.feedErrors(slug), JSON.stringify({ errors, warnings }, null, 2), {
      contentType: 'application/json',
    });
    deps.log('Feed failed validation; previous feed left in place', { slug, errors });
    return { status: 'invalid', errors, warnings };
  }

  const key = show.status === 'live' ? publicKey(layout.feed(slug)) : layout.previewFeed(slug);
  const sha256 = createHash('sha256').update(xml).digest('hex');
  const current = await store.head(key);
  if (current?.metadata['sha256'] === sha256) return { status: 'unchanged', key, warnings };

  await store.put(key, xml, {
    contentType: 'application/rss+xml; charset=utf-8',
    cacheControl: FEED_CACHE_CONTROL,
    metadata: { sha256 },
  });
  if ((await store.head(layout.feedErrors(slug))) !== undefined) {
    await store.delete([layout.feedErrors(slug)]);
  }

  if (show.status === 'live') {
    await deps.invalidate([`/${layout.feed(slug)}`]);
    if (show.podcastIndexNotify) {
      const url = feedUrl(deps.baseUrl, slug);
      // Best effort: a failed ping never fails a publish.
      await deps
        .notifyPodcastIndex(url)
        .catch((e: unknown) => deps.log('Podcast Index ping failed', { url, error: String(e) }));
    }
  }
  deps.log('Feed written', { slug, key, episodes: episodes.length });
  return { status: 'written', key, warnings };
}
