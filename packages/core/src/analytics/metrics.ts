/**
 * The contract between ingestion sources and the dashboard. Every source
 * (CloudFront logs, prefix redirects, YouTube, CSV imports) writes daily
 * items in this shape; the dashboard only ever reads them. Adding a source
 * means writing these items with a new `source` value, nothing else.
 */
export const SOURCES = ['cloudfront', 'prefix', 'youtube', 'apple-csv', 'spotify-csv'] as const;
export type MetricSource = (typeof SOURCES)[number];

export interface DailyCounts {
  /** Downloads that count as listens (IAB-style: deduped, over one minute of audio, no bots). */
  downloads: number;
  /** Downloads by self-hosted servers (audiobookshelf etc.): downloads, not listens. */
  serverDownloads: number;
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
};

export function emptyCounts(): DailyCounts {
  return { downloads: 0, serverDownloads: 0, apps: {}, countries: {}, devices: {} };
}

export function addCounts(into: DailyCounts, from: DailyCounts): DailyCounts {
  into.downloads += from.downloads;
  into.serverDownloads += from.serverDownloads;
  for (const k of ['apps', 'countries', 'devices'] as const) {
    for (const [name, n] of Object.entries(from[k])) into[k][name] = (into[k][name] ?? 0) + n;
  }
  return into;
}
