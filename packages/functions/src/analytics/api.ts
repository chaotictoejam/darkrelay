import {
  addChannelCounts,
  addCounts,
  canView,
  emptyChannelCounts,
  emptyCounts,
  metricKeys,
  SLUG,
  type Access,
  type ChannelCounts,
  type ChannelMetricItem,
  type MetricItem,
} from '@darkrelay/core';

export type Query = (
  pk: string,
  sk?: { between?: [string, string]; beginsWith?: string; latest?: boolean },
) => Promise<Record<string, unknown>[]>;

export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

export const FORBIDDEN: ApiResponse = {
  statusCode: 403,
  body: { error: "You don't have access to this brand" },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EPISODE = /^[0-9a-f]{16}$/;
/** A platform's own video id: YouTube's are 11 characters, others vary. */
const VIDEO = /^[A-Za-z0-9_-]{5,64}$/;
const OUTLET = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function dateRange(params: Record<string, string | undefined>, now: Date) {
  const to =
    params['to'] && DATE.test(params['to']) ? params['to'] : now.toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.parse(to) - 89 * 86_400_000).toISOString().slice(0, 10);
  const from = params['from'] && DATE.test(params['from']) ? params['from'] : defaultFrom;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** An outlet as the ingestion runs record it on the brand's row. */
export interface OutletRow {
  id: string;
  kind: string;
  name: string;
  source: string;
}

function outletRows(brandRow: Record<string, unknown> | undefined): OutletRow[] {
  const outlets = brandRow?.['outlets'];
  if (!Array.isArray(outlets)) return [];
  return outlets
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      id: String(o['id'] ?? ''),
      kind: String(o['kind'] ?? ''),
      name: String(o['name'] ?? o['id'] ?? ''),
      source: String(o['source'] ?? ''),
    }))
    .filter((o) => o.id);
}

/**
 * Which outlet a daily item came from. Items written since outlets exist say
 * so; older ones are matched by their source, which is exact as long as a
 * brand has one outlet per kind. A source with no outlet (an import, a
 * disconnected channel) is kept as an outlet of its own so no number is
 * silently dropped.
 */
export function outletOf(item: Pick<MetricItem, 'source' | 'outlet'>, outlets: OutletRow[]) {
  const byId = item.outlet && outlets.find((o) => o.id === item.outlet);
  if (byId) return byId;
  const bySource = outlets.find((o) => o.source === item.source);
  if (bySource) return bySource;
  return { id: item.source, kind: 'unknown', name: item.source, source: item.source };
}

/** Daily totals across outlets plus breakdowns summed over the range. */
export function summarize(items: MetricItem[], outlets: OutletRow[] = []) {
  const byDate = new Map<string, { date: string; downloads: number; serverDownloads: number }>();
  const total = emptyCounts();
  const sources = new Set<string>();
  const bySource = new Map<
    string,
    { source: string; plays: number; watchSeconds: number; apps: Record<string, number> }
  >();
  const byOutlet = new Map<
    string,
    OutletRow & { plays: number; watchSeconds: number; apps: Record<string, number> }
  >();
  for (const i of items) {
    const s = bySource.get(i.source) ?? { source: i.source, plays: 0, watchSeconds: 0, apps: {} };
    s.plays += i.downloads;
    s.watchSeconds += i.watchSeconds ?? 0;
    for (const [name, n] of Object.entries(i.apps)) s.apps[name] = (s.apps[name] ?? 0) + n;
    bySource.set(i.source, s);

    const row = outletOf(i, outlets);
    const o = byOutlet.get(row.id) ?? { ...row, plays: 0, watchSeconds: 0, apps: {} };
    o.plays += i.downloads;
    o.watchSeconds += i.watchSeconds ?? 0;
    for (const [name, n] of Object.entries(i.apps)) o.apps[name] = (o.apps[name] ?? 0) + n;
    byOutlet.set(row.id, o);

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
    bySource: [...bySource.values()].sort((a, b) => b.plays - a.plays),
    byOutlet: [...byOutlet.values()].sort((a, b) => b.plays - a.plays),
  };
}

/** One outlet's own daily numbers over the range, for a channel page. */
export function summarizeChannel(items: ChannelMetricItem[]) {
  const totals = emptyChannelCounts();
  const daily: (ChannelCounts & { date: string })[] = [];
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const counts: ChannelCounts = {
      views: item.views ?? 0,
      watchSeconds: item.watchSeconds ?? 0,
      subscribersGained: item.subscribersGained ?? 0,
      subscribersLost: item.subscribersLost ?? 0,
      trafficSources: item.trafficSources ?? {},
      formats: item.formats ?? {},
    };
    daily.push({ date: item.date, ...counts });
    addChannelCounts(totals, counts);
  }
  return { daily, totals, subscriberChange: totals.subscribersGained - totals.subscribersLost };
}

const series = (query: Query, pk: string, from: string, to: string) =>
  query(pk, { between: [`D#${from}`, `D#${to}#￿`] }) as Promise<unknown> as Promise<MetricItem[]>;

function stripKeys({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) {
  return rest;
}

async function brandRow(query: Query, brand: string) {
  const rows = await query(metricKeys.brandsPk, { beginsWith: metricKeys.brandMeta(brand) });
  return rows.find((r) => r['show'] === brand);
}

/**
 * Routes a dashboard API request. Reads pre-aggregated items only, for the
 * brands the caller may see. `/brands` and `/shows` are the same tree: the
 * older name is kept so an older dashboard build keeps working.
 */
export async function route(
  query: Query,
  path: string,
  params: Record<string, string | undefined>,
  access: Access,
  now = new Date(),
): Promise<ApiResponse> {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'shows' && parts[0] !== 'brands') {
    return { statusCode: 404, body: { error: 'Not found' } };
  }

  if (parts.length === 1) {
    const [brands, runs] = await Promise.all([
      query(metricKeys.brandsPk),
      query(metricKeys.runPk('cloudfront'), { latest: true }),
    ]);
    const visible = brands
      .filter((b) => canView(access, String(b['show'])))
      .map((b) => ({
        show: b['show'],
        brand: b['show'],
        title: b['title'],
        iconKey: b['iconKey'],
        iconUrl: b['iconUrl'],
        outlets: outletRows(b),
      }));
    return { statusCode: 200, body: { shows: visible, brands: visible, lastRun: runs[0] ?? null } };
  }

  const brand = parts[1]!;
  if (!SLUG.test(brand)) return { statusCode: 400, body: { error: 'Bad brand' } };
  if (!canView(access, brand)) return FORBIDDEN;
  const { from, to } = dateRange(params, now);

  if (parts.length === 2) {
    const [content, items, row] = await Promise.all([
      query(metricKeys.brandEpisodes(brand)),
      series(query, metricKeys.brandSeries(brand), from, to),
      brandRow(query, brand),
    ]);
    const outlets = outletRows(row);
    const newestFirst = (a: Record<string, unknown>, b: Record<string, unknown>, key: string) =>
      String(b[key] ?? '').localeCompare(String(a[key] ?? ''));
    const episodes = content
      .filter((c) => String(c['sk']).startsWith('E#'))
      .sort((a, b) => newestFirst(a, b, 'pubDate'));
    const videos = content
      .filter((c) => String(c['sk']).startsWith('V#'))
      .sort((a, b) => newestFirst(a, b, 'publishedAt'));
    return {
      statusCode: 200,
      body: {
        show: brand,
        brand,
        title: row?.['title'] ?? brand,
        iconKey: row?.['iconKey'],
        iconUrl: row?.['iconUrl'],
        outlets,
        from,
        to,
        episodes: episodes.map(stripKeys),
        videos: videos.map(stripKeys),
        ...summarize(items, outlets),
      },
    };
  }

  if (parts.length === 4 && parts[2] === 'episodes') {
    const id = parts[3]!;
    if (!EPISODE.test(id)) return { statusCode: 400, body: { error: 'Bad episode' } };
    const [meta, items, row] = await Promise.all([
      query(metricKeys.brandEpisodes(brand), { beginsWith: metricKeys.episodeMeta(id) }),
      series(query, metricKeys.episodeSeries(brand, id), from, to),
      brandRow(query, brand),
    ]);
    if (!meta[0]) return { statusCode: 404, body: { error: 'No data for this episode yet' } };
    return {
      statusCode: 200,
      body: {
        show: brand,
        brand,
        from,
        to,
        episode: stripKeys(meta[0]),
        ...summarize(items, outletRows(row)),
      },
    };
  }

  if (parts.length === 4 && parts[2] === 'videos') {
    const id = parts[3]!;
    if (!VIDEO.test(id)) return { statusCode: 400, body: { error: 'Bad video' } };
    const [meta, items, row] = await Promise.all([
      query(metricKeys.brandEpisodes(brand), { beginsWith: metricKeys.videoMeta(id) }),
      series(query, metricKeys.videoSeries(brand, id), from, to),
      brandRow(query, brand),
    ]);
    if (!meta[0]) return { statusCode: 404, body: { error: 'No data for this video yet' } };
    return {
      statusCode: 200,
      body: {
        show: brand,
        brand,
        from,
        to,
        video: stripKeys(meta[0]),
        ...summarize(items, outletRows(row)),
      },
    };
  }

  if (parts.length === 4 && parts[2] === 'outlets') {
    const id = parts[3]!;
    if (!OUTLET.test(id)) return { statusCode: 400, body: { error: 'Bad outlet' } };
    const row = await brandRow(query, brand);
    const outlet = outletRows(row).find((o) => o.id === id);
    if (!outlet) return { statusCode: 404, body: { error: 'No such outlet' } };
    const [channel, content, items] = await Promise.all([
      query(metricKeys.outletSeries(brand, id), {
        between: [`D#${from}`, `D#${to}#￿`],
      }) as Promise<unknown> as Promise<ChannelMetricItem[]>,
      query(metricKeys.brandEpisodes(brand)),
      series(query, metricKeys.brandSeries(brand), from, to),
    ]);
    // Content totals come from the brand series filtered to this outlet, so
    // the page can say what DarkRelay accounts for against the channel total.
    const mine = items.filter((i) => outletOf(i, [outlet]).id === outlet.id);
    const videos = content
      .filter((c) => String(c['sk']).startsWith('V#') && (!c['outlet'] || c['outlet'] === id))
      .map(stripKeys)
      .sort((a, b) => Number(b['downloadsTotal'] ?? 0) - Number(a['downloadsTotal'] ?? 0));
    return {
      statusCode: 200,
      body: {
        show: brand,
        brand,
        title: row?.['title'] ?? brand,
        outlet,
        from,
        to,
        channel: summarizeChannel(channel),
        content: summarize(mine, [outlet]),
        videos,
      },
    };
  }

  return { statusCode: 404, body: { error: 'Not found' } };
}
