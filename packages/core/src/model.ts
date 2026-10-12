import { z } from 'zod';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A file the feed points at. `key` is relative to the public prefix of the
 * media bucket (served by CloudFront); `url` is a file hosted elsewhere, such
 * as an imported episode whose media still lives on the old host.
 */
export const AssetRef = z.union([
  z.object({ key: z.string().min(1) }).strict(),
  z.object({ url: z.url() }).strict(),
]);
export type AssetRef = z.infer<typeof AssetRef>;

export const Category = z.object({
  text: z.string().min(1),
  sub: z.string().min(1).optional(),
});

export const Person = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  group: z.string().optional(),
  href: z.url().optional(),
  img: z.url().optional(),
});
export type Person = z.infer<typeof Person>;

export const ShowConfig = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(SLUG),
  /** draft: the feed is built to a private preview only. live: the public feed. */
  status: z.enum(['draft', 'live']),
  title: z.string().min(1),
  description: z.string().min(1),
  link: z.url(),
  language: z.string().min(2),
  author: z.string().min(1),
  owner: z.object({ name: z.string().min(1), email: z.email() }),
  image: AssetRef,
  categories: z.array(Category).min(1),
  explicit: z.boolean(),
  type: z.enum(['episodic', 'serial']).default('episodic'),
  copyright: z.string().optional(),
  /** Podcasting 2.0 show GUID. Never changes once set, even if the feed URL does. */
  podcastGuid: z.uuid(),
  locked: z.boolean().default(true),
  /** Set only on a feed that is being retired, to send apps to its replacement. */
  newFeedUrl: z.url().optional(),
  podcastIndexNotify: z.boolean().default(false),
  source: z
    .object({
      feedUrl: z.url(),
      importedAt: z.iso.datetime(),
      locked: z.boolean().optional(),
    })
    .optional(),
});
export type ShowConfig = z.infer<typeof ShowConfig>;
export type ShowConfigInput = z.input<typeof ShowConfig>;

export const Enclosure = z.object({
  asset: AssetRef,
  length: z.number().int().nonnegative(),
  type: z.string().min(1),
});

export const Transcript = z.object({
  asset: AssetRef,
  type: z.string().min(1),
  language: z.string().optional(),
  rel: z.string().optional(),
});

export const EpisodeManifest = z.object({
  schemaVersion: z.literal(1),
  /** RSS item <guid>, kept byte-for-byte. Apps use it to tell episodes apart. */
  guid: z.string().min(1),
  /** Absent when the source feed had no isPermaLink attribute; kept that way. */
  guidIsPermaLink: z.boolean().optional(),
  status: z.enum(['published', 'hidden']).default('published'),
  title: z.string().min(1),
  description: z.string(),
  link: z.url().optional(),
  pubDate: z.iso.datetime({ offset: true }),
  durationSeconds: z.number().int().nonnegative().optional(),
  episodeType: z.enum(['full', 'trailer', 'bonus']).default('full'),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
  explicit: z.boolean().optional(),
  image: AssetRef.optional(),
  enclosure: Enclosure,
  transcripts: z.array(Transcript).default([]),
  chapters: AssetRef.optional(),
  persons: z.array(Person).default([]),
  keywords: z.array(z.string()).default([]),
  /** Phase 3: the original video, kept for transcoding. Not in the feed yet. */
  video: AssetRef.optional(),
  /** Original URLs of files copied in by migrate-media, keyed by role. */
  migratedFrom: z.record(z.string(), z.url()).optional(),
  updatedAt: z.iso.datetime(),
});
export type EpisodeManifest = z.infer<typeof EpisodeManifest>;
export type EpisodeManifestInput = z.input<typeof EpisodeManifest>;
