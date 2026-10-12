import {
  addCounts,
  emptyCounts,
  episodeId as idOf,
  metricKeys,
  windowTotals,
  type DailyCounts,
  type EpisodeManifest,
  type MetricItem,
  type ShowConfig,
  type YouTube,
} from '@darkrelay/core';

const SOURCE = 'youtube' as const;
const idFor = (e: EpisodeManifest) => idOf(e.guid);

export interface YouTubeAnalyticsDeps {
  shows(): Promise<ShowConfig[]>;
  episodes(show: string): Promise<EpisodeManifest[]>;
  youtubeFor(connection: string): Promise<YouTube>;
  put(items: Record<string, unknown>[]): Promise<void>;
  episodeSeries(show: string, episodeId: string): Promise<MetricItem[]>;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface Range {
  from: string;
  to: string;
}

/**
 * YouTube finalises a day's numbers two to three days later, so each night
 * re-reads the last week. Re-reading overwrites, so nothing double counts.
 */
export function defaultRange(now: Date): Range {
  const day = (offset: number) =>
    new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  return { from: day(7), to: day(1) };
}

/**
 * Pulls views and watch time per episode per day, and each recent episode's
 * retention curve, for every show with a YouTube connection. Writes the same
 * daily items as the CloudFront counter, with source "youtube".
 */
export async function pullYouTube(deps: YouTubeAnalyticsDeps, range: Range) {
  const updatedAt = deps.now().toISOString();
  const summary: Record<string, { videos: number; days: number }> = {};

  for (const show of await deps.shows()) {
    if (!show.youtube) continue;
    const linked = (await deps.episodes(show.slug)).filter((e) => e.youtube?.videoId);
    if (!linked.length) continue;
    const yt = await deps.youtubeFor(show.youtube.connection);
    const showDays = new Map<string, DailyCounts>();
    const items: Record<string, unknown>[] = [];
    const touched: EpisodeManifest[] = [];

    for (const ep of linked) {
      const episodeId = idFor(ep);
      const rows = await yt.report({
        startDate: range.from,
        endDate: range.to,
        metrics: 'views,estimatedMinutesWatched',
        dimensions: 'day',
        filters: `video==${ep.youtube!.videoId}`,
        sort: 'day',
      });
      for (const row of rows) {
        const date = String(row['day']);
        const views = Number(row['views'] ?? 0);
        const counts: DailyCounts = {
          ...emptyCounts(),
          downloads: views,
          watchSeconds: Math.round(Number(row['estimatedMinutesWatched'] ?? 0) * 60),
          apps: views ? { YouTube: views } : {},
        };
        items.push({
          pk: metricKeys.episodeSeries(show.slug, episodeId),
          sk: metricKeys.day(date, SOURCE),
          show: show.slug,
          episodeId,
          date,
          source: SOURCE,
          updatedAt,
          ...counts,
        } satisfies MetricItem);
        addCounts(showDays.get(date) ?? showDays.set(date, emptyCounts()).get(date)!, counts);
      }
      if (rows.length) touched.push(ep);

      // Retention: the share of viewers still watching at each point of the video.
      if (Date.parse(ep.pubDate) > deps.now().getTime() - 365 * 86_400_000) {
        const curve = await yt.report({
          startDate: ep.pubDate.slice(0, 10) < range.to ? ep.pubDate.slice(0, 10) : range.to,
          endDate: range.to,
          metrics: 'audienceWatchRatio',
          dimensions: 'elapsedVideoTimeRatio',
          filters: `video==${ep.youtube!.videoId}`,
        });
        if (curve.length) {
          items.push({
            pk: metricKeys.episodeSeries(show.slug, episodeId),
            sk: metricKeys.retention(SOURCE),
            show: show.slug,
            episodeId,
            source: SOURCE,
            through: range.to,
            points: curve.map((r) => ({
              at: Number(r['elapsedVideoTimeRatio']),
              watching: Number(r['audienceWatchRatio']),
            })),
            updatedAt,
          });
        }
      }
    }

    for (const [date, counts] of showDays) {
      items.push({
        pk: metricKeys.showSeries(show.slug),
        sk: metricKeys.day(date, SOURCE),
        show: show.slug,
        date,
        source: SOURCE,
        updatedAt,
        ...counts,
      } satisfies MetricItem);
    }
    items.push({
      pk: metricKeys.showsPk,
      sk: metricKeys.showMeta(show.slug),
      show: show.slug,
      title: show.title,
    });
    await deps.put(items);

    // Episode summaries count every source, so recompute them for the episodes that changed.
    const summaries: Record<string, unknown>[] = [];
    for (const ep of touched) {
      const episodeId = idFor(ep);
      const series = (await deps.episodeSeries(show.slug, episodeId)).filter((i) =>
        i.sk.startsWith('D#'),
      );
      summaries.push({
        pk: metricKeys.showEpisodes(show.slug),
        sk: metricKeys.episodeMeta(episodeId),
        show: show.slug,
        episodeId,
        guid: ep.guid,
        title: ep.title,
        pubDate: ep.pubDate,
        youtubeVideoId: ep.youtube!.videoId,
        ...windowTotals(ep.pubDate, series),
        updatedAt,
      });
    }
    await deps.put(summaries);
    summary[show.slug] = { videos: linked.length, days: showDays.size };
  }

  const run = {
    pk: metricKeys.runPk(SOURCE),
    sk: range.to,
    date: range.to,
    from: range.from,
    shows: summary,
    updatedAt,
  };
  await deps.put([run]);
  deps.log('Pulled YouTube Analytics', run);
  return run;
}
