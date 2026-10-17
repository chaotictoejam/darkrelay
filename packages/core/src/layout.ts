import { createHash, randomBytes } from 'node:crypto';
import type { AssetRef } from './model';

/**
 * Media bucket layout. Only `public/` is reachable through CloudFront; its
 * origin path is `/public`, so `public/<show>/feed.xml` is served at
 * `https://<domain>/<show>/feed.xml`.
 */
export const PUBLIC_PREFIX = 'public/';

/** Media keys are versioned (a new upload gets a new key), so caches can keep them forever. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const layout = {
  showConfig: (show: string) => `catalog/${show}/show.json`,
  episodesPrefix: (show: string) => `catalog/${show}/episodes/`,
  episodeManifest: (show: string, episodeId: string) =>
    `catalog/${show}/episodes/${episodeId}.json`,
  previewFeed: (show: string) => `catalog/${show}/feed.preview.xml`,
  feedErrors: (show: string) => `catalog/${show}/feed-errors.json`,
  /** Public-relative key; prefix with PUBLIC_PREFIX for the bucket key. */
  feed: (show: string) => `${show}/feed.xml`,
  episodeAsset: (show: string, episodeId: string, version: string, file: string) =>
    `${show}/${episodeId}/${version}/${file}`,
  inboxPrefix: (show: string, bundleId: string) => `inbox/${show}/${bundleId}/`,
  inboxStatus: (show: string, bundleId: string) => `inbox-status/${show}/${bundleId}.json`,
  rebuildRequest: (show: string) => `requests/${show}/rebuild`,
  youtubeUpload: (show: string, episodeId: string) => `catalog/${show}/youtube/${episodeId}.json`,
};

/** Upload id for a bundle under inbox/: sortable by time, unique enough to never collide. */
export function newBundleId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Stable, path-safe id for an episode, derived from its RSS guid. */
export function episodeId(guid: string): string {
  return createHash('sha256').update(guid).digest('hex').slice(0, 16);
}

export function publicKey(key: string): string {
  return PUBLIC_PREFIX + key;
}

export function resolveAsset(asset: AssetRef, baseUrl: string): string {
  if ('url' in asset) return asset.url;
  return `${baseUrl.replace(/\/+$/, '')}/${asset.key.split('/').map(encodeURIComponent).join('/')}`;
}

export function feedUrl(baseUrl: string, show: string): string {
  return resolveAsset({ key: layout.feed(show) }, baseUrl);
}
