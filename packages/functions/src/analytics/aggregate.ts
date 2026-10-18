import {
  addCounts,
  countDownloads,
  emptyCounts,
  metricKeys,
  type DailyCounts,
  type EpisodeFile,
  type EpisodeManifest,
  type FileFacts,
  type MetricItem,
  type RequestGroup,
  windowTotals,
} from '@darkrelay/core';

export { windowTotals };

export interface AggregateDeps {
  /** Rows from dailyQuery for the date. */
  queryDay(date: string): Promise<{ rows: Record<string, string>[]; bytesScanned: number }>;
  loadManifest(show: string, episodeId: string): Promise<EpisodeManifest | undefined>;
  loadShowTitle(show: string): Promise<string | undefined>;
  put(items: Record<string, unknown>[]): Promise<void>;
  /** Every daily item for one episode, all sources, oldest first. */
  episodeSeries(show: string, episodeId: string): Promise<MetricItem[]>;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

const SOURCE = 'cloudfront' as const;

/** CloudFront logs URL-encode the User-Agent (spaces become %20). */
export function decodeUserAgent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

export function toGroups(rows: Record<string, string>[]): RequestGroup[] {
  return rows.map((r) => ({
    path: r['path'] ?? '',
    userAgent: decodeUserAgent(r['user_agent'] ?? ''),
    country: r['country'] || undefined,
    asn: r['asn'] || undefined,
    client: r['client'] || undefined,
    requests: Number(r['requests'] ?? 0),
    bytes: Number(r['bytes'] ?? 0),
  }));
}

/**
 * Processes one UTC day of CloudFront logs into daily metric items, show
 * totals, and per-episode 7/30/90-day summaries. Re-running a day
 * overwrites the same items, so late logs are picked up by re-runs.
 */
export async function aggregateDay(deps: AggregateDeps, date: string) {
  const updatedAt = deps.now().toISOString();
  const { rows, bytesScanned } = await deps.queryDay(date);

  const manifests = new Map<string, EpisodeManifest | undefined>();
  const manifestFor = async (f: EpisodeFile) => {
    const key = `${f.show}/${f.episodeId}`;
    if (!manifests.has(key)) manifests.set(key, await deps.loadManifest(f.show, f.episodeId));
    return manifests.get(key);
  };
  const groups = toGroups(rows);
  // Load facts up front: countDownloads is synchronous.
  for (const g of groups) {
    const m = /^\/([^/]+)\/([0-9a-f]{16})\//.exec(g.path);
    if (m) await manifestFor({ show: m[1]!, episodeId: m[2]! });
  }
  const factsFor = (f: EpisodeFile): FileFacts => {
    const m = manifests.get(`${f.show}/${f.episodeId}`);
    return m ? { length: m.enclosure.length || undefined, durationSeconds: m.durationSeconds } : {};
  };
  const { episodes, filtered } = countDownloads(groups, factsFor);

  const items: Record<string, unknown>[] = [];
  const showTotals = new Map<string, DailyCounts>();
  for (const c of episodes.values()) {
    const { show, episodeId, ...counts } = c;
    items.push({
      pk: metricKeys.episodeSeries(show, episodeId),
      sk: metricKeys.day(date, SOURCE),
      show,
      episodeId,
      date,
      source: SOURCE,
      updatedAt,
      ...counts,
    } satisfies MetricItem);
    addCounts(showTotals.get(show) ?? showTotals.set(show, emptyCounts()).get(show)!, counts);
  }
  for (const [show, counts] of showTotals) {
    items.push({
      pk: metricKeys.showSeries(show),
      sk: metricKeys.day(date, SOURCE),
      show,
      date,
      source: SOURCE,
      updatedAt,
      ...counts,
    } satisfies MetricItem);
    const title = await deps.loadShowTitle(show);
    if (title) items.push({ pk: metricKeys.showsPk, sk: metricKeys.showMeta(show), show, title });
  }
  await deps.put(items);

  // Episode summaries need the full series, so they're written after the day's items.
  const summaries: Record<string, unknown>[] = [];
  for (const c of episodes.values()) {
    const m = manifests.get(`${c.show}/${c.episodeId}`);
    if (!m) continue;
    const series = (await deps.episodeSeries(c.show, c.episodeId)).filter((i) =>
      i.sk.startsWith('D#'),
    );
    summaries.push({
      pk: metricKeys.showEpisodes(c.show),
      sk: metricKeys.episodeMeta(c.episodeId),
      show: c.show,
      episodeId: c.episodeId,
      guid: m.guid,
      title: m.title,
      pubDate: m.pubDate,
      ...windowTotals(m.pubDate, series),
      updatedAt,
    });
  }
  const run = {
    pk: metricKeys.runPk(SOURCE),
    sk: date,
    date,
    groups: rows.length,
    episodes: episodes.size,
    filtered,
    bytesScanned,
    updatedAt,
  };
  await deps.put([...summaries, run]);
  deps.log('Aggregated day', run);
  return run;
}

/** The days a scheduled run covers: yesterday, plus the day before for late logs. */
export function defaultDates(now: Date): string[] {
  const day = (offset: number) =>
    new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  return [day(2), day(1)];
}
