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
  video: z
    .object({
      /**
       * Build HLS from uploaded video and list it in the feed as a
       * podcast:alternateEnclosure. Off for audio-first shows (an audiogram
       * is kept for YouTube but not streamed).
       */
      hls: z.boolean().default(false),
      /** HLS rendition heights; renditions taller than the source are skipped. */
      ladder: z.array(z.number().int().min(144).max(2160)).min(1).default([1080, 720, 480]),
    })
    .default({ hls: false, ladder: [1080, 720, 480] }),
  youtube: z
    .object({
      /** Name of a channel connected with `darkrelay youtube connect <name>`. */
      connection: z.string().regex(/^[a-z0-9-]{1,40}$/),
      /** Upload each episode's video automatically when it publishes. */
      upload: z.boolean().default(true),
      privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
      /** YouTube category id: 22 People & Blogs, 27 Education, 28 Science & Technology. */
      categoryId: z.string().regex(/^\d+$/).default('22'),
      playlistId: z.string().optional(),
      tags: z.array(z.string()).default([]),
      /** Appended to every description, e.g. links to the show. */
      descriptionFooter: z.string().optional(),
    })
    .optional(),
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

export const AlternateEnclosure = z.object({
  asset: AssetRef,
  type: z.string().min(1),
  title: z.string().optional(),
  height: z.number().int().positive().optional(),
  bitrate: z.number().int().positive().optional(),
  length: z.number().int().nonnegative().optional(),
});
export type AlternateEnclosure = z.infer<typeof AlternateEnclosure>;

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
  alternateEnclosures: z.array(AlternateEnclosure).default([]),
  transcripts: z.array(Transcript).default([]),
  chapters: AssetRef.optional(),
  persons: z.array(Person).default([]),
  keywords: z.array(z.string()).default([]),
  /** The uploaded video as-is (an audiogram or full video), kept for YouTube. Not in the feed. */
  video: AssetRef.optional(),
  /** The episode's YouTube video, uploaded by DarkRelay or linked to an existing one. */
  youtube: z
    .object({
      videoId: z.string().min(1),
      linkedAt: z.iso.datetime(),
      /** The release time YouTube was given, to resync if the episode is rescheduled. */
      publishAt: z.iso.datetime().optional(),
    })
    .optional(),
  /** Original URLs of files copied in by migrate-media, keyed by role. */
  migratedFrom: z.record(z.string(), z.url()).optional(),
  updatedAt: z.iso.datetime(),
});
export type EpisodeManifest = z.infer<typeof EpisodeManifest>;
export type EpisodeManifestInput = z.input<typeof EpisodeManifest>;
