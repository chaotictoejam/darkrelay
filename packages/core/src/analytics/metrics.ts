/**
 * The contract between ingestion sources and the dashboard. Every source
 * (CloudFront logs, prefix redirects, YouTube, CSV imports) writes daily
 * items in this shape; the dashboard only ever reads them. Adding a source
 * means writing these items with a new `source` value, nothing else.
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
  apps: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
}

export interface MetricItem extends DailyCounts {
  pk: string;
  sk: string;
  show: string;
  /** Absent on show-level totals. */
  episodeId?: string;
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

export interface ShowMetaItem {
  pk: string;
  sk: string;
  show: string;
  title: string;
}

export const metricKeys = {
  episodeSeries: (show: string, episodeId: string) => `S#${show}#E#${episodeId}`,
  showSeries: (show: string) => `S#${show}#ALL`,
  day: (date: string, source: MetricSource) => `D#${date}#${source}`,
  showEpisodes: (show: string) => `S#${show}`,
  episodeMeta: (episodeId: string) => `E#${episodeId}`,
  showsPk: 'SHOWS',
  showMeta: (show: string) => `S#${show}`,
  runPk: (source: MetricSource) => `RUN#${source}`,
  /** Audience retention curve for an episode from one source (phase 5 charts it). */
  retention: (source: MetricSource) => `RET#${source}`,
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
