import {
  addChannelCounts,
  emptyChannelCounts,
  metricKeys,
  videoFormat,
  type ChannelCounts,
  type ChannelMetricItem,
} from '@darkrelay/core';

const SOURCE = 'youtube' as const;

/** The one call shape every report here needs; `YouTube.report` satisfies it. */
export type Report = (params: Record<string, string>) => Promise<Record<string, string | number>[]>;

export interface Range {
  from: string;
  to: string;
}

export interface ReportLog {
  (message: string, data?: Record<string, unknown>): void;
}

/** The video dimension caps at 200 rows a page; paging is bounded so a run cannot run away. */
const PAGE = 200;
const MAX_PAGES = 10;

const num = (v: string | number | undefined) => Number(v ?? 0) || 0;

/**
 * Runs a report, and on failure logs and returns nothing. Analytics is never
 * allowed to fail a whole night's run: a dimension YouTube refuses for this
 * channel costs that one breakdown, not the views and watch time.
 */
async function soft(
  report: Report,
  params: Record<string, string>,
  what: string,
  log: ReportLog,
): Promise<Record<string, string | number>[]> {
  try {
    return await report(params);
  } catch (e) {
    log('YouTube report failed; continuing without it', { what, error: String(e) });
    return [];
  }
}

/**
 * A channel's own numbers per day: views and watch time, subscribers gained
 * and lost, where the views came from, and the Shorts/long-form split.
 *
 * These describe the channel, not any one video, so they are stored under the
 * outlet and never added to brand totals.
 */
export async function pullChannelCounts(
  report: Report,
  range: Range,
  log: ReportLog,
): Promise<Map<string, ChannelCounts>> {
  const days = new Map<string, ChannelCounts>();
  const dayOf = (date: string) => days.get(date) ?? days.set(date, emptyChannelCounts()).get(date)!;

  const totals = await soft(
    report,
    {
      startDate: range.from,
      endDate: range.to,
      metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
      dimensions: 'day',
      sort: 'day',
    },
    'channel totals',
    log,
  );
  for (const row of totals) {
    const day = dayOf(String(row['day']));
    day.views += num(row['views']);
    day.watchSeconds += Math.round(num(row['estimatedMinutesWatched']) * 60);
    day.subscribersGained += num(row['subscribersGained']);
    day.subscribersLost += num(row['subscribersLost']);
  }

  const traffic = await soft(
    report,
    {
      startDate: range.from,
      endDate: range.to,
      metrics: 'views',
      dimensions: 'day,insightTrafficSourceType',
    },
    'traffic sources',
    log,
  );
  for (const row of traffic) {
    const day = dayOf(String(row['day']));
    const name = String(row['insightTrafficSourceType'] ?? 'UNKNOWN');
    day.trafficSources[name] = (day.trafficSources[name] ?? 0) + num(row['views']);
  }

  const formats = await soft(
    report,
    {
      startDate: range.from,
      endDate: range.to,
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'day,creatorContentType',
    },
    'Shorts and long-form split',
    log,
  );
  for (const row of formats) {
    const day = dayOf(String(row['day']));
    const format = videoFormat(String(row['creatorContentType'] ?? ''));
    const into = (day.formats[format] ??= { views: 0, watchSeconds: 0 });
    into.views += num(row['views']);
    into.watchSeconds += Math.round(num(row['estimatedMinutesWatched']) * 60);
  }

  return days;
}

export function channelItems(
  brand: string,
  outlet: string,
  days: Map<string, ChannelCounts>,
  updatedAt: string,
): Record<string, unknown>[] {
  return [...days].map(
    ([date, counts]) =>
      ({
        pk: metricKeys.outletSeries(brand, outlet),
        sk: metricKeys.day(date, SOURCE),
        show: brand,
        outlet,
        date,
        source: SOURCE,
        updatedAt,
        ...counts,
      }) satisfies ChannelMetricItem,
  );
}

/** Channel totals over the whole range, for an outlet page's headline numbers. */
export function channelTotals(days: Map<string, ChannelCounts>): ChannelCounts {
  const total = emptyChannelCounts();
  for (const counts of days.values()) addChannelCounts(total, counts);
  return total;
}

/**
 * Videos with any views in the range, most watched first. One report instead
 * of one per video: a nightly run then only asks for the daily detail of
 * videos that actually moved, so its cost follows activity, not catalogue
 * size.
 */
export async function listActiveVideos(
  report: Report,
  range: Range,
  log: ReportLog,
): Promise<{ videoId: string; views: number }[]> {
  const out: { videoId: string; views: number }[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await soft(
      report,
      {
        startDate: range.from,
        endDate: range.to,
        metrics: 'views',
        dimensions: 'video',
        sort: '-views',
        maxResults: String(PAGE),
        startIndex: String(page * PAGE + 1),
      },
      'active videos',
      log,
    );
    for (const row of rows) {
      out.push({ videoId: String(row['video']), views: num(row['views']) });
    }
    if (rows.length < PAGE) break;
    if (page === MAX_PAGES - 1)
      log('Stopped listing active videos at the page limit', { out: out.length });
  }
  return out;
}

/**
 * The videos YouTube itself calls Shorts, from `creatorContentType`. Duration
 * cannot answer this: a three-minute talk is not a Short, and a Short is not
 * always under a minute. Videos with no views in the range are absent, so
 * callers fall back to `classifyVideo`.
 */
export async function listShorts(
  report: Report,
  range: Range,
  log: ReportLog,
): Promise<Set<string>> {
  const shorts = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await soft(
      report,
      {
        startDate: range.from,
        endDate: range.to,
        metrics: 'views',
        dimensions: 'video',
        filters: 'creatorContentType==SHORTS',
        sort: '-views',
        maxResults: String(PAGE),
        startIndex: String(page * PAGE + 1),
      },
      'Shorts',
      log,
    );
    for (const row of rows) shorts.add(String(row['video']));
    if (rows.length < PAGE) break;
  }
  return shorts;
}
