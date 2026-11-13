import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OUTLET_ID } from './brand';
import { episodeId } from './layout';
import { AssetRef, SLUG, type EpisodeManifest } from './model';
import { YT_DESCRIPTION_MAX_BYTES, YT_TITLE_MAX } from './youtube';

/**
 * What a brand publishes. An episode's record is still its own manifest —
 * the feed is built from those, and nothing here is allowed to change that —
 * so only the kinds that have no feed of their own are stored as content.
 * `contentFromEpisode` projects an episode into the same shape, so the
 * dashboard and the planner can treat a brand's output as one list.
 */
export const CONTENT_KINDS = ['episode', 'video', 'short'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Kinds that live in the content store. An episode is published by the feed. */
export const STORED_KINDS = ['video', 'short'] as const;

export const CONTENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PUBLICATION_STATES = [
  'planned',
  'scheduled',
  'uploading',
  'published',
  'failed',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

const noAngles = (s: string) => !/[<>]/.test(s);

/**
 * One item on one outlet. `planned` has a slot but nothing has been sent;
 * `scheduled` is uploaded and waiting for YouTube to make it public at
 * `publishAt`; `published` is out.
 */
export const Publication = z.object({
  outlet: z.string().regex(OUTLET_ID),
  state: z.enum(PUBLICATION_STATES).default('planned'),
  /** The platform's own id once it exists, e.g. a YouTube video id. */
  externalId: z.string().min(1).optional(),
  /** When it goes live. The upload happens days before this. */
  publishAt: z.iso.datetime().optional(),
  /** When the bytes were actually sent, which is not when it goes live. */
  uploadedAt: z.iso.datetime().optional(),
  /** The release time the platform was last given, to resync on a reschedule. */
  sentPublishAt: z.iso.datetime().optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  updatedAt: z.iso.datetime().optional(),
});
export type Publication = z.infer<typeof Publication>;

/**
 * A video or a Short, kept at `catalog/<brand>/content/<id>.json`. The media
 * stays private in the catalog until the platform publishes it: a Short has
 * no feed, so there is no reason for a public URL to exist first.
 */
export const ContentItem = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(CONTENT_ID),
  brand: z.string().regex(SLUG),
  kind: z.enum(STORED_KINDS),
  title: z
    .string()
    .trim()
    .min(1)
    .max(YT_TITLE_MAX, `Titles are limited to ${YT_TITLE_MAX} characters`)
    .refine(noAngles, 'YouTube does not allow < or > in titles'),
  /** Plain text, as YouTube shows it. */
  description: z
    .string()
    .refine(
      (s) => new TextEncoder().encode(s).length <= YT_DESCRIPTION_MAX_BYTES,
      `Descriptions are limited to ${YT_DESCRIPTION_MAX_BYTES} bytes`,
    )
    .refine(noAngles, 'YouTube does not allow < or > in descriptions')
    .default(''),
  tags: z.array(z.string()).default([]),
  /**
   * The episode this was clipped from, as an episode id. A standalone Short
   * has none, which is a normal thing for it to be.
   */
  parentId: z.string().optional(),
  /** Bucket key of the media, private until the platform publishes it. */
  media: AssetRef,
  thumbnail: AssetRef.optional(),
  /** The slot: when this should go live. Phase 4's planner fills these in. */
  publishAt: z.iso.datetime().optional(),
  publications: z.array(Publication).default([]),
  /** The batch it arrived in, for `shorts status`. */
  batchId: z.string().optional(),
  /**
   * Position in the batch manifest. The planner releases a batch in the
   * order it was written, which matters when the clips tell a story in
   * sequence; ids are hashes and sort arbitrarily.
   */
  seq: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContentItem = z.infer<typeof ContentItem>;
export type ContentItemInput = z.input<typeof ContentItem>;

/**
 * One Short in a batch manifest: the file beside it, and what to say about
 * it. Everything except the file and title is optional, because a batch is
 * usually written by hand.
 */
export const ShortsManifestItem = z.object({
  file: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Episode guid or episode id this was clipped from. */
  parentId: z.string().optional(),
  /** A slot, if you already know it. Otherwise phase 4's planner assigns one. */
  publishAt: z.iso.datetime().optional(),
  thumbnail: z.string().optional(),
  /** Overrides the id derived from the file name. */
  id: z.string().regex(CONTENT_ID).optional(),
});
export type ShortsManifestItem = z.infer<typeof ShortsManifestItem>;

export const ShortsManifest = z.object({
  schemaVersion: z.literal(1),
  /** Checked against the brand the batch was uploaded under, if present. */
  brand: z.string().regex(SLUG).optional(),
  kind: z.enum(STORED_KINDS).default('short'),
  /** The outlet these go to. Defaults to the brand's first YouTube outlet. */
  outlet: z.string().regex(OUTLET_ID).optional(),
  defaults: z
    .object({
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      parentId: z.string().optional(),
    })
    .optional(),
  shorts: z.array(ShortsManifestItem).min(1),
});
export type ShortsManifest = z.infer<typeof ShortsManifest>;
export type ShortsManifestInput = z.input<typeof ShortsManifest>;

/** File name of a batch manifest in an upload, the way `episode.json` names a bundle. */
export const SHORTS_MANIFEST_FILE = 'shorts.json';

/**
 * A stable, path-safe id for one piece of content. Derived from the file
 * name so that re-uploading the same batch updates the same items instead of
 * making duplicates, with a short hash to keep two files of the same name in
 * different batches apart.
 */
export function contentIdFor(file: string, batchId = ''): string {
  const base = (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const hash = createHash('sha256').update(`${batchId}/${file}`).digest('hex').slice(0, 8);
  return `${slug || 'clip'}-${hash}`;
}

/** The publication for one outlet, if the item goes there. */
export function publicationFor(item: ContentItem, outlet: string): Publication | undefined {
  return item.publications.find((p) => p.outlet === outlet);
}

/** Adds or replaces the publication for an outlet, leaving the others alone. */
export function withPublication(item: ContentItem, publication: Publication): ContentItem {
  const publications = item.publications.some((p) => p.outlet === publication.outlet)
    ? item.publications.map((p) => (p.outlet === publication.outlet ? publication : p))
    : [...item.publications, publication];
  return { ...item, publications };
}

/**
 * How long before its slot an item is uploaded. Days, not minutes: YouTube
 * needs the video processed before it can go public, and an upload that
 * fails must leave time to notice and retry.
 */
export const DEFAULT_LEAD_DAYS = 3;

/**
 * Whether an item should be uploaded now: it has a slot, that slot is inside
 * the lead time, and nothing has been sent yet. An item whose slot has
 * already passed is still uploaded — late is better than never, and YouTube
 * publishes it immediately.
 */
export function dueForUpload(
  item: ContentItem,
  outlet: string,
  now: Date,
  leadDays = DEFAULT_LEAD_DAYS,
): boolean {
  if (!item.publishAt) return false;
  const publication = publicationFor(item, outlet);
  if (publication && publication.state !== 'planned' && publication.state !== 'failed') {
    return false;
  }
  return Date.parse(item.publishAt) - now.getTime() <= leadDays * 86_400_000;
}

/**
 * Items whose slot moved after they were uploaded, so the platform is
 * holding the wrong release time.
 */
export function needsReschedule(item: ContentItem, outlet: string): boolean {
  const publication = publicationFor(item, outlet);
  if (!publication || publication.state !== 'scheduled' || !publication.externalId) return false;
  return (publication.sentPublishAt ?? '') !== (item.publishAt ?? '');
}

/**
 * A piece of content of any kind, stored or projected. A stored
 * `ContentItem` is one; so is an episode run through `contentFromEpisode`.
 */
export type ContentView = Omit<ContentItem, 'kind'> & { kind: ContentKind };

/**
 * An episode as a piece of content, so a brand's output reads as one list.
 * Nothing is stored: the episode manifest stays the only record of it.
 */
export function contentFromEpisode(brand: string, episode: EpisodeManifest): ContentView {
  const id = episodeId(episode.guid);
  return {
    schemaVersion: 1,
    id,
    brand,
    kind: 'episode' as ContentKind,
    title: episode.title,
    description: '',
    tags: episode.keywords,
    media: episode.video ?? episode.enclosure.asset,
    thumbnail: episode.thumbnail ?? episode.image,
    publishAt: episode.pubDate,
    publications: episode.youtube
      ? [
          {
            outlet: 'youtube',
            state: episode.youtube.publishAt ? 'scheduled' : 'published',
            externalId: episode.youtube.videoId,
            publishAt: episode.youtube.publishAt ?? episode.pubDate,
            sentPublishAt: episode.youtube.publishAt,
            warnings: [],
          },
        ]
      : [],
    createdAt: episode.pubDate,
    updatedAt: episode.updatedAt,
  };
}
