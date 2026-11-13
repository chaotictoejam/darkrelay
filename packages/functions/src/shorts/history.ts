import { metricKeys, type MetricItem, type SlotSample, type VideoFormat } from '@darkrelay/core';

/**
 * The brand's own publishing history, as the slot scorer wants it: one
 * record per video, with how it did in its first few days and — crucially —
 * the exact moment it went out.
 *
 * Everything here is read from the metrics table. Nothing calls YouTube: the
 * nightly pull has already stored what is needed, and a planning run must
 * not spend upload quota or fail because a token expired.
 */

export type Query = (
  pk: string,
  sk?: { between?: [string, string]; beginsWith?: string },
) => Promise<Record<string, unknown>[]>;

export interface HistoryDeps {
  query: Query;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

/**
 * Days of data that make up the "first 72 hours". Calendar days in the
 * source's own reckoning, because that is the grain the daily items have:
 * the publish day and the two after it.
 */
const WINDOW_DAYS = 3;

/**
 * A video needs to have been out this long before it counts as evidence.
 * Scoring a video that is one day old against videos with a full three days
 * would make every recent slot look weak.
 */
export const SETTLED_DAYS = 3;

/** Newest videos first, and only this many, so a long channel stays cheap. */
const MAX_VIDEOS = 300;

/**
 * Series read at once. A handful at a time is well inside a table's read
 * capacity and keeps an interactive request from waiting on a long queue.
 */
const CONCURRENCY = 8;

interface MetaRow {
  sk: string;
  videoId?: string;
  episodeId?: string;
  title?: string;
  publishedAt?: string;
  pubDate?: string;
  format?: VideoFormat;
  durationSeconds?: number;
  youtubeVideoId?: string;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Reads a brand's videos and episodes, then the first three days of each
 * one's daily numbers. Only YouTube days are counted: a slot score is about
 * when to post on a channel, and feed downloads say nothing about that.
 */
export async function loadHistory(deps: HistoryDeps, brand: string): Promise<SlotSample[]> {
  const settledBefore = deps.now().getTime() - SETTLED_DAYS * 86_400_000;
  const meta = (await deps.query(metricKeys.brandEpisodes(brand))) as unknown as MetaRow[];

  const subjects = meta
    .map((row) => subject(brand, row))
    .filter((s): s is Subject => !!s)
    .filter((s) => {
      const at = Date.parse(s.publishedAt);
      return Number.isFinite(at) && at <= settledBefore;
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, MAX_VIDEOS);

  const sampleFor = async (s: Subject): Promise<SlotSample | undefined> => {
    const start = Date.parse(s.publishedAt.slice(0, 10) + 'T00:00:00Z');
    const first = day(start);
    const last = day(start + (WINDOW_DAYS - 1) * 86_400_000);
    const rows = (await deps.query(s.pk, {
      between: [`D#${first}`, `D#${last}#\uffff`],
    })) as unknown as MetricItem[];
    const youtube = rows.filter((r) => r.source === 'youtube');
    if (!youtube.length) return undefined;
    return {
      id: s.id,
      title: s.title,
      publishedAt: s.publishedAt,
      format: s.format,
      views72h: youtube.reduce((n, r) => n + (r.downloads ?? 0), 0),
      watchSeconds72h: youtube.reduce((n, r) => n + (r.watchSeconds ?? 0), 0),
      durationSeconds: s.durationSeconds,
      subscribersGained72h: youtube.some((r) => r.subscribersGained !== undefined)
        ? youtube.reduce((n, r) => n + (r.subscribersGained ?? 0), 0)
        : undefined,
    };
  };

  // A handful of series at a time: one query per video in sequence is what
  // makes an interactive heatmap feel slow.
  const samples: SlotSample[] = [];
  for (let i = 0; i < subjects.length; i += CONCURRENCY) {
    const batch = await Promise.all(subjects.slice(i, i + CONCURRENCY).map(sampleFor));
    for (const sample of batch) if (sample) samples.push(sample);
  }

  deps.log('Loaded publishing history', {
    brand,
    candidates: subjects.length,
    samples: samples.length,
  });
  return samples;
}

interface Subject {
  id: string;
  pk: string;
  title?: string;
  publishedAt: string;
  format: VideoFormat;
  durationSeconds?: number;
}

/**
 * One row of the brand's meta partition as something scoreable. Videos carry
 * their own format and duration; an episode's video is long-form by
 * definition, and only counts if it went to YouTube at all.
 */
function subject(brand: string, row: MetaRow): Subject | undefined {
  if (row.sk?.startsWith('V#') && row.videoId) {
    return {
      id: row.videoId,
      pk: metricKeys.videoSeries(brand, row.videoId),
      title: row.title,
      publishedAt: row.publishedAt ?? '',
      format: row.format ?? 'other',
      durationSeconds: row.durationSeconds,
    };
  }
  if (row.sk?.startsWith('E#') && row.episodeId && row.youtubeVideoId) {
    return {
      id: row.episodeId,
      pk: metricKeys.episodeSeries(brand, row.episodeId),
      title: row.title,
      publishedAt: row.pubDate ?? '',
      format: 'long',
    };
  }
  return undefined;
}
