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
  /**
   * Brand identity and its outlets. Written next to the feed config, never
   * instead of it: the publisher ignores this file, so a brand change can
   * never affect a feed.
   */
  brandConfig: (brand: string) => `catalog/${brand}/brand.json`,
  /** Public-relative key; prefix with PUBLIC_PREFIX for the bucket key. */
  brandIcon: (brand: string, hash: string, ext: string) => `${brand}/icon-${hash}.${ext}`,
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
  /**
   * Content that is not an episode. The media sits beside its record and
   * stays private: a video or a Short has no feed, so nothing needs a public
   * URL before the platform publishes it.
   */
  contentPrefix: (brand: string) => `catalog/${brand}/content/`,
  contentItem: (brand: string, id: string) => `catalog/${brand}/content/${id}.json`,
  contentMedia: (brand: string, id: string, file: string) =>
    `catalog/${brand}/content/${id}/${file}`,
  contentUpload: (brand: string, id: string) => `catalog/${brand}/content/${id}.upload.json`,
};

const CATALOG_KEY = /^catalog\/([a-z0-9][a-z0-9-]{0,62})\/([^/]+)$/;

/** Brand and content id from a content record's key, for S3 event routing. */
export function contentKeyParts(key: string): { brand: string; id: string } | undefined {
  const m = /^catalog\/([a-z0-9][a-z0-9-]{0,62})\/content\/([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(
    key,
  );
  return m ? { brand: m[1]!, id: m[2]! } : undefined;
}

/**
 * The slug in a catalog key for one file, e.g. `catalog/<slug>/brand.json`.
 * Undefined for any other key, so listing `catalog/` and filtering is safe.
 */
export function catalogSlug(key: string, file: string): string | undefined {
  const m = CATALOG_KEY.exec(key);
  return m && m[2] === file ? m[1] : undefined;
}

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
