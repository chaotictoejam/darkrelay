import { createHash, randomUUID } from 'node:crypto';

/** Namespace from the Podcasting 2.0 spec for <podcast:guid>. */
export const PODCAST_GUID_NAMESPACE = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function uuidV5(name: string, namespace: string): string {
  if (!isUuid(namespace)) throw new Error(`Invalid namespace UUID: ${namespace}`);
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The show GUID a feed has when it never declared one: UUIDv5 of the feed URL
 * without its scheme and trailing slashes. For an imported show this must be
 * computed from the ORIGINAL feed URL, not the new one.
 */
export function podcastGuidFromFeedUrl(feedUrl: string): string {
  const name = feedUrl
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');
  return uuidV5(name, PODCAST_GUID_NAMESPACE);
}

/** Namespace for GUIDs DarkRelay derives itself (e.g. for a bundle uploaded without one). */
export const DARKRELAY_NAMESPACE = '6f0b4c1e-2d7a-5e8b-9c3f-1a2b3c4d5e6f';

export function newEpisodeGuid(): string {
  return randomUUID();
}
