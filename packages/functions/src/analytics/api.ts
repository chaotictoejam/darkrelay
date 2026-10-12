import { addCounts, emptyCounts, metricKeys, SLUG, type MetricItem } from '@darkrelay/core';

export type Query = (
  pk: string,
  sk?: { between?: [string, string]; beginsWith?: string; latest?: boolean },
) => Promise<Record<string, unknown>[]>;

export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EPISODE = /^[0-9a-f]{16}$/;

export function dateRange(params: Record<string, string | undefined>, now: Date) {
  const to =
    params['to'] && DATE.test(params['to']) ? params['to'] : now.toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.parse(to) - 89 * 86_400_000).toISOString().slice(0, 10);
  const from = params['from'] && DATE.test(params['from']) ? params['from'] : defaultFrom;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Daily totals across sources plus breakdowns summed over the range. */
export function summarize(items: MetricItem[]) {
  const byDate = new Map<string, { date: string; downloads: number; serverDownloads: number }>();
  const total = emptyCounts();
  const sources = new Set<string>();
  for (const i of items) {
    const d = byDate.get(i.date) ?? { date: i.date, downloads: 0, serverDownloads: 0 };
    d.downloads += i.downloads;
    d.serverDownloads += i.serverDownloads;
    byDate.set(i.date, d);
    addCounts(total, i);
    sources.add(i.source);
  }
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: total,
    sources: [...sources].sort(),
  };
}

const series = (query: Query, pk: string, from: string, to: string) =>
  query(pk, { between: [`D#${from}`, `D#${to}#￿`] }) as Promise<unknown> as Promise<MetricItem[]>;

/** Routes a dashboard API request. Reads pre-aggregated items only. */
export async function route(
  query: Query,
  path: string,
  params: Record<string, string | undefined>,
  now = new Date(),
): Promise<ApiResponse> {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'shows') return { statusCode: 404, body: { error: 'Not found' } };

  if (parts.length === 1) {
    const [shows, runs] = await Promise.all([
      query(metricKeys.showsPk),
      query(metricKeys.runPk('cloudfront'), { latest: true }),
    ]);
    return {
      statusCode: 200,
      body: {
        shows: shows.map((s) => ({ show: s['show'], title: s['title'] })),
        lastRun: runs[0] ?? null,
      },
    };
  }

  const show = parts[1]!;
  if (!SLUG.test(show)) return { statusCode: 400, body: { error: 'Bad show' } };
  const { from, to } = dateRange(params, now);

  if (parts.length === 2) {
    const [episodes, items] = await Promise.all([
      query(metricKeys.showEpisodes(show), { beginsWith: 'E#' }),
      series(query, metricKeys.showSeries(show), from, to),
    ]);
    const sorted = episodes.sort((a, b) =>
      String(b['pubDate']).localeCompare(String(a['pubDate'])),
    );
    return {
      statusCode: 200,
      body: { show, from, to, episodes: sorted.map(stripKeys), ...summarize(items) },
    };
  }

  if (parts.length === 4 && parts[2] === 'episodes') {
    const id = parts[3]!;
    if (!EPISODE.test(id)) return { statusCode: 400, body: { error: 'Bad episode' } };
    const [meta, items] = await Promise.all([
      query(metricKeys.showEpisodes(show), { beginsWith: metricKeys.episodeMeta(id) }),
      series(query, metricKeys.episodeSeries(show, id), from, to),
    ]);
    if (!meta[0]) return { statusCode: 404, body: { error: 'No data for this episode yet' } };
    return {
      statusCode: 200,
      body: { show, from, to, episode: stripKeys(meta[0]), ...summarize(items) },
    };
  }
  return { statusCode: 404, body: { error: 'Not found' } };
}

function stripKeys({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) {
  return rest;
}
