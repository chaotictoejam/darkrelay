/**
 * The contract between ingestion sources and the dashboard. Every source
 * (CloudFront logs, prefix redirects, YouTube, CSV imports) writes daily
 * items in this shape; the dashboard only ever reads them. Adding a source
 * means writing these items with a new `source` value, nothing else.
 *
 * A brand's outlets map onto `source`: see `outletSource` in `brand.ts`.
 */
export const SOURCES = ['cloudfront', 'prefix', 'youtube', 'apple-csv', 'spotify-csv'] as const;
export type MetricSource = (typeof SOURCES)[number];

export interface DailyCounts {
  /**
   * Plays: downloads for RSS sources (IAB-style: deduped, over one minute of
   * audio, no bots), views for YouTube, plays for platform exports.
   */
  downloads: number;
  /** Time listened or watched, in seconds, where the source knows it (YouTube, Spotify, Apple). */
  watchSeconds?: number;
  /** Downloads by self-hosted servers (audiobookshelf etc.): downloads, not listens. */
  serverDownloads: number;
  /** Downloads (included in `downloads`) from networks that look like a crawler. */
  suspectDownloads?: number;
  /**
   * Subscribers gained from this item on this day, where the platform
   * attributes them to a video. Only YouTube reports it; a feed has no
   * equivalent, so it is absent rather than zero elsewhere.
   */
  subscribersGained?: number;
  apps: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
}

export interface MetricItem extends DailyCounts {
  pk: string;
  sk: string;
  /**
   * The brand slug. The field is named `show` because it predates brands and
   * is kept so no stored item is ever rewritten; a migrated show's brand has
   * the same slug, so the value does not change either.
   */
  show: string;
  /** Absent on brand-level totals. */
  episodeId?: string;
  /** The platform's id, on items for content that is not an episode. */
  videoId?: string;
  /** The outlet the numbers came from, where the writer knew it. */
  outlet?: string;
  /** UTC day, YYYY-MM-DD. */
  date: string;
  source: MetricSource;
  updatedAt: string;
}

export interface EpisodeMetaItem {
  pk: string;
  sk: string;
  show: string;
  episodeId: string;
  guid: string;
  title: string;
  pubDate: string;
}

export interface BrandMetaItem {
  pk: string;
  sk: string;
  show: string;
  title: string;
}
/** @deprecated Shows are brands; use {@link BrandMetaItem}. */
export type ShowMetaItem = BrandMetaItem;

/**
 * Keys are unchanged from before brands: `S#<slug>` now means the brand, and
 * a migrated show's brand keeps its slug, so no stored item moves. The
 * `show*` names are kept as aliases of the `brand*` ones for the same reason.
 */
export const metricKeys = {
  episodeSeries: (brand: string, episodeId: string) => `S#${brand}#E#${episodeId}`,
  /**
   * Content that is not an episode (a video, a Short), keyed by the
   * platform's own id. Same `DailyCounts` shape as an episode series.
   */
  videoSeries: (brand: string, videoId: string) => `S#${brand}#V#${videoId}`,
  /**
   * One outlet's own numbers, e.g. a channel's subscribers and traffic
   * sources. Never summed into brand totals: a channel counts views of
   * everything on it, including content DarkRelay knows nothing about.
   */
  outletSeries: (brand: string, outlet: string) => `S#${brand}#O#${outlet}`,
  brandSeries: (brand: string) => `S#${brand}#ALL`,
  day: (date: string, source: MetricSource) => `D#${date}#${source}`,
  /** Partition holding one item per episode and per video of a brand. */
  brandEpisodes: (brand: string) => `S#${brand}`,
  episodeMeta: (episodeId: string) => `E#${episodeId}`,
  videoMeta: (videoId: string) => `V#${videoId}`,
  brandsPk: 'SHOWS',
  brandMeta: (brand: string) => `S#${brand}`,
  runPk: (source: MetricSource) => `RUN#${source}`,
  /** Audience retention curve for an episode from one source (phase 5 charts it). */
  retention: (source: MetricSource) => `RET#${source}`,

  /** @deprecated Use `brandSeries`. */
  showSeries: (brand: string) => `S#${brand}#ALL`,
  /** @deprecated Use `brandEpisodes`. */
  showEpisodes: (brand: string) => `S#${brand}`,
  /** @deprecated Use `brandsPk`. */
  showsPk: 'SHOWS',
  /** @deprecated Use `brandMeta`. */
  showMeta: (brand: string) => `S#${brand}`,
};

export function emptyCounts(): DailyCounts {
  return { downloads: 0, serverDownloads: 0, apps: {}, countries: {}, devices: {} };
}

export function addCounts(into: DailyCounts, from: DailyCounts): DailyCounts {
  into.downloads += from.downloads;
  into.serverDownloads += from.serverDownloads;
  if (from.suspectDownloads)
    into.suspectDownloads = (into.suspectDownloads ?? 0) + from.suspectDownloads;
  if (from.watchSeconds) into.watchSeconds = (into.watchSeconds ?? 0) + from.watchSeconds;
  if (from.subscribersGained)
    into.subscribersGained = (into.subscribersGained ?? 0) + from.subscribersGained;
  for (const k of ['apps', 'countries', 'devices'] as const) {
    for (const [name, n] of Object.entries(from[k])) into[k][name] = (into[k][name] ?? 0) + n;
  }
  return into;
}

/** Plays in the first 7/30/90 days after release (release day is day 0), across all sources. */
export function windowTotals(
  pubDate: string,
  series: Pick<
    MetricItem,
    'date' | 'downloads' | 'serverDownloads' | 'suspectDownloads' | 'watchSeconds'
  >[],
) {
  const start = Date.parse(pubDate.slice(0, 10) + 'T00:00:00Z');
  const totals = {
    downloads7: 0,
    downloads30: 0,
    downloads90: 0,
    downloadsTotal: 0,
    serverTotal: 0,
    suspectTotal: 0,
    watchSecondsTotal: 0,
  };
  for (const item of series) {
    const age = Math.floor((Date.parse(item.date + 'T00:00:00Z') - start) / 86_400_000);
    totals.downloadsTotal += item.downloads;
    totals.serverTotal += item.serverDownloads;
    totals.suspectTotal += item.suspectDownloads ?? 0;
    totals.watchSecondsTotal += item.watchSeconds ?? 0;
    if (age < 7) totals.downloads7 += item.downloads;
    if (age < 30) totals.downloads30 += item.downloads;
    if (age < 90) totals.downloads90 += item.downloads;
  }
  return totals;
}

/** The format axis YouTube reports on: a Short behaves nothing like a talk. */
export const VIDEO_FORMATS = ['short', 'long', 'live', 'other'] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

/**
 * YouTube Analytics' `creatorContentType` dimension, which is the only
 * authoritative answer to "is this a Short?" the API gives.
 */
export function videoFormat(creatorContentType: string): VideoFormat {
  switch (creatorContentType.toUpperCase()) {
    case 'SHORTS':
      return 'short';
    case 'VIDEO_ON_DEMAND':
      return 'long';
    case 'LIVE_STREAM':
      return 'live';
    default:
      return 'other';
  }
}

/**
 * Channel-level numbers for one outlet on one day. Separate from
 * `DailyCounts` because these are properties of the channel, not of a piece
 * of content: they cannot be added up per episode, and they must never be
 * added to brand totals.
 */
export interface ChannelCounts {
  views: number;
  watchSeconds: number;
  subscribersGained: number;
  subscribersLost: number;
  /** Views by `insightTrafficSourceType`, e.g. SHORTS_FEED, YT_SEARCH. */
  trafficSources: Record<string, number>;
  /** Views and watch time per format, so Shorts and long-form stay apart. */
  formats: Partial<Record<VideoFormat, { views: number; watchSeconds: number }>>;
}

export interface ChannelMetricItem extends ChannelCounts {
  pk: string;
  sk: string;
  /** The brand slug. */
  show: string;
  /** The outlet id within the brand. */
  outlet: string;
  date: string;
  source: MetricSource;
  updatedAt: string;
}

export function emptyChannelCounts(): ChannelCounts {
  return {
    views: 0,
    watchSeconds: 0,
    subscribersGained: 0,
    subscribersLost: 0,
    trafficSources: {},
    formats: {},
  };
}

export function addChannelCounts(into: ChannelCounts, from: ChannelCounts): ChannelCounts {
  into.views += from.views;
  into.watchSeconds += from.watchSeconds;
  into.subscribersGained += from.subscribersGained;
  into.subscribersLost += from.subscribersLost;
  for (const [name, n] of Object.entries(from.trafficSources)) {
    into.trafficSources[name] = (into.trafficSources[name] ?? 0) + n;
  }
  for (const [name, f] of Object.entries(from.formats) as [
    VideoFormat,
    { views: number; watchSeconds: number },
  ][]) {
    const target = (into.formats[name] ??= { views: 0, watchSeconds: 0 });
    target.views += f.views;
    target.watchSeconds += f.watchSeconds;
  }
  return into;
}

/**
 * One item per video of a brand, alongside the episode items: what the video
 * is, and its totals. `episodeId` is set when the video is an episode's own
 * video, so the dashboard does not list it twice.
 */
export interface VideoMetaItem {
  pk: string;
  sk: string;
  show: string;
  outlet: string;
  videoId: string;
  title: string;
  publishedAt: string;
  format: VideoFormat;
  durationSeconds?: number;
  episodeId?: string;
  /** The episode a Short was clipped from, once Shorts carry one. */
  parentId?: string;
}
