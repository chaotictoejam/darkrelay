import {
  addCounts,
  brandMetaItem,
  classifyVideo,
  emptyCounts,
  episodeId as idOf,
  feedShow,
  metricKeys,
  outletsOfKind,
  parseIsoDuration,
  SHORT_MAX_SECONDS,
  windowTotals,
  type BrandConfig,
  type DailyCounts,
  type EpisodeManifest,
  type MetricItem,
  type VideoMetaItem,
  type YouTube,
  type YouTubeOutlet,
} from '@darkrelay/core';
import {
  channelItems,
  listActiveVideos,
  listShorts,
  pullChannelCounts,
  type Range,
  type Report,
} from './channel';

const SOURCE = 'youtube' as const;
const idFor = (e: EpisodeManifest) => idOf(e.guid);

export interface YouTubeAnalyticsDeps {
  /** Every brand in the deployment; those without a YouTube outlet are skipped. */
  brands(): Promise<BrandConfig[]>;
  /** Episodes of a feed, to recognise videos that are an episode's own. */
  episodes(show: string): Promise<EpisodeManifest[]>;
  youtubeFor(connection: string): Promise<YouTube>;
  put(items: Record<string, unknown>[]): Promise<void>;
  /** Every daily item under one series key, all sources, for the summaries. */
  series(pk: string): Promise<MetricItem[]>;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export type { Range };

export interface PullOptions {
  /**
   * List the channel's uploads, so videos with no views in the range are
   * recorded too. Worth it for a backfill, wasted quota every night.
   */
  listUploads?: boolean;
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

interface VideoFacts {
  title: string;
  publishedAt: string;
  durationSeconds?: number;
  /** `public`, `private` or `unlisted`, as the platform reports it. */
  privacyStatus?: string;
  /** The release time YouTube is holding a scheduled video for. */
  scheduledAt?: string;
  /** Width ÷ height of the upload, where YouTube still reports the file. */
  aspectRatio?: number;
}

/**
 * Pulls every YouTube outlet of every brand: channel-level numbers, then the
 * daily detail of whatever moved in the range. Episodes keep writing to their
 * episode series exactly as before; everything else on the channel becomes a
 * video series under the same brand.
 */
export async function pullYouTube(
  deps: YouTubeAnalyticsDeps,
  range: Range,
  opts: PullOptions = {},
) {
  const updatedAt = deps.now().toISOString();
  const summary: Record<string, { outlets: number; videos: number; days: number }> = {};

  for (const brand of await deps.brands()) {
    const outlets = outletsOfKind(brand, 'youtube');
    if (!outlets.length) continue;
    // Brand totals are shared by every outlet, so they are summed here and
    // written once: two channels must not overwrite each other's day.
    const brandDays = new Map<string, DailyCounts>();
    let videos = 0;

    for (const outlet of outlets) {
      try {
        videos += await pullOutlet(deps, brand, outlet, range, updatedAt, brandDays, opts);
      } catch (e) {
        // A channel that is not connected yet, or a revoked token, must not
        // stop the other outlets or the other brands.
        deps.log('Skipping YouTube outlet', {
          brand: brand.slug,
          outlet: outlet.id,
          connection: outlet.connection,
          error: String(e),
        });
      }
    }

    const items: Record<string, unknown>[] = [...brandDays].map(([date, counts]) => ({
      pk: metricKeys.brandSeries(brand.slug),
      sk: metricKeys.day(date, SOURCE),
      show: brand.slug,
      date,
      source: SOURCE,
      updatedAt,
      ...counts,
    }));
    items.push(brandMetaItem(brand));
    await deps.put(items);
    summary[brand.slug] = { outlets: outlets.length, videos, days: brandDays.size };
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

async function pullOutlet(
  deps: YouTubeAnalyticsDeps,
  brand: BrandConfig,
  outlet: YouTubeOutlet,
  range: Range,
  updatedAt: string,
  brandDays: Map<string, DailyCounts>,
  opts: PullOptions,
): Promise<number> {
  const yt = await deps.youtubeFor(outlet.connection);
  const report: Report = (params) => yt.report(params);
  const log = deps.log;

  const channelDays = await pullChannelCounts(report, range, log);
  if (channelDays.size) {
    await deps.put(channelItems(brand.slug, outlet.id, channelDays, updatedAt));
  }

  const feed = feedShow(brand);
  const episodes = feed ? await deps.episodes(feed) : [];
  const episodeByVideo = new Map(
    episodes.filter((e) => e.youtube?.videoId).map((e) => [e.youtube!.videoId, e]),
  );

  const active = await listActiveVideos(report, range, log);
  const shorts = await listShorts(report, range, log);
  // A video YouTube is still holding — scheduled, private, unlisted — has no
  // views, so it is never active and a nightly run would never look at it
  // again. The few of them are re-read every night instead, so the dashboard
  // stops calling something scheduled the moment it is out.
  const held = opts.listUploads ? [] : await heldVideos(deps, brand, outlet);
  if (held.length)
    log('Re-reading videos not public yet', { brand: brand.slug, held: held.length });
  const facts = await videoFacts(
    yt,
    brand,
    outlet,
    active,
    episodeByVideo,
    opts,
    log,
    held,
    shorts,
  );

  const items: Record<string, unknown>[] = [];
  const touchedEpisodes: EpisodeManifest[] = [];
  const touchedVideos: string[] = [];
  const dailyFor = videoDays(report, log);

  for (const { videoId } of active) {
    const episode = episodeByVideo.get(videoId);
    const pk = episode
      ? metricKeys.episodeSeries(brand.slug, idFor(episode))
      : metricKeys.videoSeries(brand.slug, videoId);
    const rows = await dailyFor(videoId, range);
    for (const row of rows) {
      const date = String(row['day']);
      const views = Number(row['views'] ?? 0);
      const counts: DailyCounts = {
        ...emptyCounts(),
        downloads: views,
        watchSeconds: Math.round(Number(row['estimatedMinutesWatched'] ?? 0) * 60),
        apps: views ? { YouTube: views } : {},
        ...(row['subscribersGained'] === undefined
          ? {}
          : { subscribersGained: Number(row['subscribersGained']) || 0 }),
      };
      items.push({
        pk,
        sk: metricKeys.day(date, SOURCE),
        show: brand.slug,
        ...(episode ? { episodeId: idFor(episode) } : { videoId }),
        outlet: outlet.id,
        date,
        source: SOURCE,
        updatedAt,
        ...counts,
      } satisfies MetricItem);
      addCounts(brandDays.get(date) ?? brandDays.set(date, emptyCounts()).get(date)!, counts);
    }
    if (!rows.length) continue;
    if (episode) touchedEpisodes.push(episode);
    else touchedVideos.push(videoId);

    // Retention: the share of viewers still watching at each point.
    const published = episode?.pubDate ?? facts.get(videoId)?.publishedAt;
    if (published && Date.parse(published) > deps.now().getTime() - 365 * 86_400_000) {
      const curve = await report({
        startDate: published.slice(0, 10) < range.to ? published.slice(0, 10) : range.to,
        endDate: range.to,
        metrics: 'audienceWatchRatio',
        dimensions: 'elapsedVideoTimeRatio',
        filters: `video==${videoId}`,
      });
      if (curve.length) {
        items.push({
          pk,
          sk: metricKeys.retention(SOURCE),
          show: brand.slug,
          ...(episode ? { episodeId: idFor(episode) } : { videoId }),
          outlet: outlet.id,
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
  await deps.put(items);

  // Summaries need the whole series, so they are written after the day's items.
  const summaries: Record<string, unknown>[] = [];
  for (const episode of touchedEpisodes) {
    const id = idFor(episode);
    const series = (await deps.series(metricKeys.episodeSeries(brand.slug, id))).filter((i) =>
      i.sk.startsWith('D#'),
    );
    summaries.push({
      pk: metricKeys.brandEpisodes(brand.slug),
      sk: metricKeys.episodeMeta(id),
      show: brand.slug,
      episodeId: id,
      guid: episode.guid,
      title: episode.title,
      pubDate: episode.pubDate,
      youtubeVideoId: episode.youtube!.videoId,
      ...windowTotals(episode.pubDate, series),
      updatedAt,
    });
  }

  // Every video we know of gets a meta item, so the dashboard can list a
  // channel's content even where a video had no views in this range.
  for (const [videoId, fact] of facts) {
    if (episodeByVideo.has(videoId)) continue;
    const known = opts.listUploads || touchedVideos.includes(videoId) || held.includes(videoId);
    if (!known) continue;
    const series = (await deps.series(metricKeys.videoSeries(brand.slug, videoId))).filter((i) =>
      i.sk.startsWith('D#'),
    );
    const meta: VideoMetaItem & Record<string, unknown> = {
      pk: metricKeys.brandEpisodes(brand.slug),
      sk: metricKeys.videoMeta(videoId),
      show: brand.slug,
      outlet: outlet.id,
      videoId,
      title: fact.title,
      publishedAt: fact.publishedAt,
      format: classifyVideo({
        durationSeconds: fact.durationSeconds,
        creatorContentType: shorts.has(videoId) ? 'SHORTS' : undefined,
        aspectRatio: fact.aspectRatio,
      }),
      durationSeconds: fact.durationSeconds,
      // Both are written only when the platform reports them, and the row is
      // replaced whole, so a video that goes public loses its release time
      // rather than keeping a date it has already passed.
      ...(fact.privacyStatus ? { privacyStatus: fact.privacyStatus } : {}),
      ...(fact.scheduledAt ? { scheduledAt: fact.scheduledAt } : {}),
      ...windowTotals(fact.publishedAt || range.from, series),
      updatedAt,
    };
    summaries.push(meta);
  }
  await deps.put(summaries);

  deps.log('Pulled YouTube outlet', {
    brand: brand.slug,
    outlet: outlet.id,
    channelDays: channelDays.size,
    active: active.length,
    episodes: touchedEpisodes.length,
    videos: touchedVideos.length,
  });
  return touchedVideos.length;
}

/**
 * The videos this outlet has already recorded as not public yet: scheduled,
 * private or unlisted. Read from the summaries rather than from the channel,
 * because listing a channel's uploads costs quota every night and the answer
 * for all but a handful of videos is "public, as it was yesterday".
 */
async function heldVideos(
  deps: YouTubeAnalyticsDeps,
  brand: BrandConfig,
  outlet: YouTubeOutlet,
): Promise<string[]> {
  const rows = (await deps.series(metricKeys.brandEpisodes(brand.slug))) as unknown as Record<
    string,
    unknown
  >[];
  return rows
    .filter((r) => String(r['sk'] ?? '').startsWith('V#'))
    .filter((r) => !r['outlet'] || r['outlet'] === outlet.id)
    .filter((r) => r['scheduledAt'] || (r['privacyStatus'] && r['privacyStatus'] !== 'public'))
    .map((r) => String(r['videoId'] ?? ''))
    .filter(Boolean);
}

/**
 * One video's daily numbers. Subscribers gained is asked for alongside the
 * views, because slot scoring needs to know which publish times win
 * subscribers and not merely views — but if a channel refuses the metric the
 * run drops it once and carries on with the rest, rather than losing a
 * night's views over a breakdown.
 */
function videoDays(report: Report, log: YouTubeAnalyticsDeps['log']) {
  let withSubscribers = true;
  return async (videoId: string, range: Range) => {
    const params = {
      startDate: range.from,
      endDate: range.to,
      dimensions: 'day',
      filters: `video==${videoId}`,
      sort: 'day',
    };
    if (withSubscribers) {
      try {
        return await report({
          ...params,
          metrics: 'views,estimatedMinutesWatched,subscribersGained',
        });
      } catch (e) {
        withSubscribers = false;
        log('subscribersGained unavailable for this channel; continuing without it', {
          error: String(e),
        });
      }
    }
    return report({ ...params, metrics: 'views,estimatedMinutesWatched' });
  };
}

/**
 * Title, publish date and duration for the videos that are not an episode's
 * own. A backfill lists the channel's uploads so dormant videos are recorded
 * too; a nightly run asks only about the videos that moved.
 */
async function videoFacts(
  yt: YouTube,
  brand: BrandConfig,
  outlet: YouTubeOutlet,
  active: { videoId: string }[],
  episodeByVideo: Map<string, EpisodeManifest>,
  opts: PullOptions,
  log: YouTubeAnalyticsDeps['log'],
  alsoWanted: string[] = [],
  shorts: Set<string> = new Set(),
): Promise<Map<string, VideoFacts>> {
  const facts = new Map<string, VideoFacts>();
  const wanted = new Set(
    [...active.map((a) => a.videoId), ...alsoWanted].filter((id) => !episodeByVideo.has(id)),
  );

  if (opts.listUploads) {
    const channel = await yt.myChannel();
    for (const upload of await yt.listUploads(channel.uploadsPlaylist)) {
      if (episodeByVideo.has(upload.videoId)) continue;
      facts.set(upload.videoId, { title: upload.title, publishedAt: upload.publishedAt });
      wanted.add(upload.videoId);
    }
    log('Listed channel uploads', {
      brand: brand.slug,
      outlet: outlet.id,
      channel: channel.id,
      videos: facts.size,
    });
  }

  if (!wanted.size) return facts;
  // Durations come from the Data API; Analytics does not report them.
  for (const details of await yt.videoDetails([...wanted])) {
    const previous = facts.get(details.id);
    facts.set(details.id, {
      title: details.title ?? previous?.title ?? details.id,
      publishedAt: details.publishedAt ?? previous?.publishedAt ?? '',
      durationSeconds: parseIsoDuration(details.duration),
      privacyStatus: details.privacyStatus,
      scheduledAt: details.scheduledAt,
    });
  }

  // Only the videos that length alone would decide need a second look, which
  // is a handful per run: everything Analytics already named is settled, and
  // so is anything over three minutes.
  const unsure = [...facts]
    .filter(
      ([id, f]) => !shorts.has(id) && f.durationSeconds && f.durationSeconds <= SHORT_MAX_SECONDS,
    )
    .map(([id]) => id);
  if (unsure.length) {
    try {
      const shapes = await yt.videoShapes(unsure);
      for (const [id, aspectRatio] of shapes) facts.set(id, { ...facts.get(id)!, aspectRatio });
      log('Read video shapes', {
        brand: brand.slug,
        outlet: outlet.id,
        asked: unsure.length,
        answered: shapes.size,
      });
    } catch (e) {
      // The file details are a nicety, not the run: without them the format
      // falls back to length, which is what it did before they existed.
      log('Could not read video shapes', {
        brand: brand.slug,
        outlet: outlet.id,
        videos: unsure.length,
        error: String(e),
      });
    }
  }
  return facts;
}
