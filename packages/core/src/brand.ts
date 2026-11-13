import { z } from 'zod';
import { metricKeys, type MetricSource } from './analytics/metrics';
import { AssetRef, SLUG, type ShowConfig } from './model';

/**
 * A brand is what DarkRelay publishes and measures. Content belongs to the
 * brand; outlets are the places it goes out. Not every brand is a podcast:
 * a YouTube-only brand has no feed at all.
 *
 * A brand may have more than one outlet of a kind (two feeds, two channels),
 * so outlets are a list with ids rather than a map keyed by kind.
 */
export const OUTLET_KINDS = ['rss', 'youtube', 'spotify', 'apple'] as const;
export type OutletKind = (typeof OUTLET_KINDS)[number];

/** Outlet ids are unique within a brand and appear in dashboard URLs. */
export const OUTLET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A channel connected with `darkrelay youtube connect <name>`. */
export const CONNECTION = /^[a-z0-9-]{1,40}$/;

const common = {
  id: z.string().regex(OUTLET_ID),
  /** Shown in place of the generated name, e.g. "Main feed". */
  label: z.string().min(1).optional(),
  addedAt: z.iso.datetime().optional(),
};

/**
 * A feed DarkRelay hosts. `show` names the feed config at
 * `catalog/<show>/show.json`, served at `/<show>/feed.xml`: a migrated show
 * keeps its slug, so no feed URL, `podcast:guid` or episode `<guid>` changes.
 */
export const RssOutlet = z.object({
  kind: z.literal('rss'),
  ...common,
  show: z.string().regex(SLUG),
});
export type RssOutlet = z.infer<typeof RssOutlet>;

/**
 * Upload settings for content that has no feed to take them from (a Short, a
 * standalone video). Everything is optional: `youtubeDefaults` falls back to
 * the brand's feed config, so a migrated brand behaves exactly as before.
 */
export const YouTubeOutletDefaults = z.object({
  upload: z.boolean().optional(),
  privacy: z.enum(['public', 'unlisted', 'private']).optional(),
  /** YouTube category id: 22 People & Blogs, 27 Education, 28 Science & Technology. */
  categoryId: z.string().regex(/^\d+$/).optional(),
  playlistId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  descriptionFooter: z.string().optional(),
});
export type YouTubeOutletDefaults = z.infer<typeof YouTubeOutletDefaults>;

/**
 * A YouTube channel. The outlet wraps an existing connection: the OAuth
 * secret stays at `<prefix>/youtube/<connection>` in SSM, untouched.
 */
export const YouTubeOutlet = z.object({
  kind: z.literal('youtube'),
  ...common,
  connection: z.string().regex(CONNECTION),
  /** Cached from the connection, for display and channel-level reports. */
  channelId: z.string().min(1).optional(),
  channelTitle: z.string().min(1).optional(),
  defaults: YouTubeOutletDefaults.optional(),
});
export type YouTubeOutlet = z.infer<typeof YouTubeOutlet>;

/** An outlet DarkRelay only measures, from the platform's own exports. */
const platformOutlet = <K extends 'spotify' | 'apple'>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    ...common,
    /** The brand's page on that platform. */
    url: z.url().optional(),
    /** The platform's own id for the show, where its exports use one. */
    showId: z.string().min(1).optional(),
  });

export const SpotifyOutlet = platformOutlet('spotify');
export const AppleOutlet = platformOutlet('apple');

export const Outlet = z.discriminatedUnion('kind', [
  RssOutlet,
  YouTubeOutlet,
  SpotifyOutlet,
  AppleOutlet,
]);
export type Outlet = z.infer<typeof Outlet>;
export type OutletInput = z.input<typeof Outlet>;
export type OutletOfKind<K extends OutletKind> = Extract<Outlet, { kind: K }>;

/**
 * Brand identity and its outlets, kept at `catalog/<slug>/brand.json`. The
 * feed config stays where it is: brand.json never duplicates it, so writing
 * one changes nothing a podcast app can see.
 */
export const BrandConfig = z
  .object({
    schemaVersion: z.literal(1),
    slug: z.string().regex(SLUG),
    /** Shown in the dashboard. A migrated show's name is its feed title. */
    name: z.string().min(1),
    /** Square image in the media bucket: the dashboard nav and brand pages. */
    icon: AssetRef.optional(),
    /**
     * The clock this brand's audience keeps, as an IANA name. Slot scoring
     * and scheduling are done in it, because "a good time to post" is a
     * statement about an audience's evening, not about UTC. Defaults to the
     * deployment's own zone.
     */
    timezone: z.string().min(1).optional(),
    outlets: z.array(Outlet).default([]),
    updatedAt: z.iso.datetime().optional(),
  })
  .check((ctx) => {
    const ids = ctx.value.outlets.map((o) => o.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: `Two outlets share the id "${duplicate}"; outlet ids must be unique within a brand`,
        path: ['outlets'],
        input: ctx.value,
      });
    }
  });
export type BrandConfig = z.infer<typeof BrandConfig>;
export type BrandConfigInput = z.input<typeof BrandConfig>;

/** Outlet id a migrated show's feed gets, and the default for a first feed. */
export const DEFAULT_RSS_OUTLET_ID = 'rss';
/** Outlet id a migrated show's YouTube connection gets. */
export const DEFAULT_YOUTUBE_OUTLET_ID = 'youtube';

/**
 * The brand an existing show becomes: same slug, the feed as its first `rss`
 * outlet, and its YouTube connection (if it has one) as a `youtube` outlet.
 * Lossless: nothing is moved or rewritten, and the show config stays the
 * source of truth for the feed and for episode uploads.
 */
export function brandFromShow(show: ShowConfig, now = new Date()): BrandConfig {
  const addedAt = now.toISOString();
  const outlets: Outlet[] = [{ kind: 'rss', id: DEFAULT_RSS_OUTLET_ID, show: show.slug, addedAt }];
  if (show.youtube) {
    outlets.push({
      kind: 'youtube',
      id: DEFAULT_YOUTUBE_OUTLET_ID,
      connection: show.youtube.connection,
      addedAt,
    });
  }
  return BrandConfig.parse({
    schemaVersion: 1,
    slug: show.slug,
    name: show.title,
    // The show's cover is square already; a dedicated icon replaces it later.
    icon: show.image,
    outlets,
    updatedAt: addedAt,
  });
}

export function outletsOfKind<K extends OutletKind>(
  brand: BrandConfig,
  kind: K,
): OutletOfKind<K>[] {
  return brand.outlets.filter((o): o is OutletOfKind<K> => o.kind === kind);
}

export function findOutlet(brand: BrandConfig, id: string): Outlet | undefined {
  return brand.outlets.find((o) => o.id === id);
}

/** The brand's feed, where it has one. A YouTube-only brand has none. */
export function feedOutlet(brand: BrandConfig): RssOutlet | undefined {
  return outletsOfKind(brand, 'rss')[0];
}

/** Slug of the feed config a brand's episodes publish through, if any. */
export function feedShow(brand: BrandConfig): string | undefined {
  return feedOutlet(brand)?.show;
}

/** Adds an outlet, or replaces the one with the same id. */
export function withOutlet(brand: BrandConfig, outlet: Outlet): BrandConfig {
  const outlets = brand.outlets.some((o) => o.id === outlet.id)
    ? brand.outlets.map((o) => (o.id === outlet.id ? outlet : o))
    : [...brand.outlets, outlet];
  return { ...brand, outlets };
}

export function withoutOutlet(brand: BrandConfig, id: string): BrandConfig {
  return { ...brand, outlets: brand.outlets.filter((o) => o.id !== id) };
}

/**
 * The metric `source` an outlet's numbers are written under, so the
 * dashboard's _By outlet_ table reads the items already there. Prefix-mode
 * feeds (hosted elsewhere) will add `prefix` when they arrive.
 */
export function outletSource(outlet: Outlet): MetricSource {
  switch (outlet.kind) {
    case 'rss':
      return 'cloudfront';
    case 'youtube':
      return 'youtube';
    case 'spotify':
      return 'spotify-csv';
    case 'apple':
      return 'apple-csv';
  }
}

/** A name to show for an outlet when it has no label of its own. */
export function outletName(outlet: Outlet): string {
  if (outlet.label) return outlet.label;
  switch (outlet.kind) {
    case 'rss':
      return `RSS feed (${outlet.show})`;
    case 'youtube':
      return outlet.channelTitle ?? `YouTube (${outlet.connection})`;
    case 'spotify':
      return 'Spotify';
    case 'apple':
      return 'Apple Podcasts';
  }
}

/**
 * Upload settings for a YouTube outlet: its own, falling back to the feed
 * config's `youtube` block. An episode published through the feed therefore
 * uploads exactly as it does today; content with no feed uses the outlet's.
 */
export function youtubeDefaults(
  outlet: YouTubeOutlet,
  show?: Pick<ShowConfig, 'youtube'>,
): Required<Pick<YouTubeOutletDefaults, 'upload' | 'privacy' | 'categoryId' | 'tags'>> &
  Pick<YouTubeOutletDefaults, 'playlistId' | 'descriptionFooter'> {
  const fromShow = show?.youtube?.connection === outlet.connection ? show.youtube : undefined;
  const d = outlet.defaults ?? {};
  return {
    upload: d.upload ?? fromShow?.upload ?? true,
    privacy: d.privacy ?? fromShow?.privacy ?? 'public',
    categoryId: d.categoryId ?? fromShow?.categoryId ?? '22',
    tags: d.tags ?? fromShow?.tags ?? [],
    playlistId: d.playlistId ?? fromShow?.playlistId,
    descriptionFooter: d.descriptionFooter ?? fromShow?.descriptionFooter,
  };
}

/**
 * The brand row the dashboard reads to build its switcher: name, icon and
 * outlets, written by every ingestion run. Keeping it in DynamoDB is what
 * lets the dashboard stay a pre-aggregated read and never touch S3.
 */
export function brandMetaItem(brand: BrandConfig) {
  return {
    pk: metricKeys.brandsPk,
    sk: metricKeys.brandMeta(brand.slug),
    show: brand.slug,
    /** The field is named `title` because the dashboard has always read it. */
    title: brand.name,
    iconKey: brand.icon && 'key' in brand.icon ? brand.icon.key : undefined,
    iconUrl: brand.icon && 'url' in brand.icon ? brand.icon.url : undefined,
    outlets: brand.outlets.map((o) => ({
      id: o.id,
      kind: o.kind,
      name: outletName(o),
      source: outletSource(o),
      ...(o.kind === 'rss' ? { show: o.show } : {}),
      ...(o.kind === 'youtube' ? { connection: o.connection, channelId: o.channelId } : {}),
    })),
  };
}
