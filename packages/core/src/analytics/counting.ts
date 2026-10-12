import { emptyCounts, type DailyCounts } from './metrics';
import { classifyUserAgent } from './useragent';

/**
 * One row from the daily query: every request for one file from one
 * IP + User-Agent pair on one UTC day, already summed. The IP itself is
 * never returned.
 */
export interface RequestGroup {
  path: string;
  userAgent: string;
  country?: string;
  requests: number;
  bytes: number;
}

export interface EpisodeFile {
  show: string;
  episodeId: string;
}

export interface FileFacts {
  /** Enclosure size in bytes, if known. */
  length?: number;
  durationSeconds?: number;
}

const AUDIO_PATH =
  /^\/([a-z0-9][a-z0-9-]{0,62})\/([0-9a-f]{16})\/[A-Za-z0-9._-]+\/audio\.(mp3|m4a)$/;

/** Maps a CloudFront path to the episode it serves. Only enclosure audio counts. */
export function parseMediaPath(path: string): EpisodeFile | undefined {
  const m = AUDIO_PATH.exec(path);
  return m ? { show: m[1]!, episodeId: m[2]! } : undefined;
}

/** Assumed bitrate when an episode's duration is unknown: 128 kbps. */
const DEFAULT_BYTES_PER_MINUTE = 960_000;

/**
 * Bytes that make a request group count as a download: one minute of
 * audio, or the whole file if it is shorter than that (IAB v2.2).
 */
export function minimumBytes(facts: FileFacts): number {
  const perMinute =
    facts.length && facts.durationSeconds
      ? Math.floor((facts.length / facts.durationSeconds) * 60)
      : DEFAULT_BYTES_PER_MINUTE;
  return facts.length ? Math.min(perMinute, facts.length) : perMinute;
}

export interface CountResult {
  /** Keyed by `${show}/${episodeId}`. */
  episodes: Map<string, DailyCounts & EpisodeFile>;
  filtered: { bots: number; belowMinimum: number; notAudio: number };
}

/**
 * IAB 2.2-style counting for one UTC day. Groups arrive already deduped by
 * IP + User-Agent + file (calendar-day window) with byte-range requests summed.
 */
export function countDownloads(
  groups: RequestGroup[],
  factsFor: (file: EpisodeFile) => FileFacts,
): CountResult {
  const episodes = new Map<string, DailyCounts & EpisodeFile>();
  const filtered = { bots: 0, belowMinimum: 0, notAudio: 0 };

  for (const g of groups) {
    const file = parseMediaPath(g.path);
    if (!file) {
      filtered.notAudio++;
      continue;
    }
    const ua = classifyUserAgent(g.userAgent);
    if (ua.kind === 'bot') {
      filtered.bots++;
      continue;
    }
    if (g.bytes < minimumBytes(factsFor(file))) {
      filtered.belowMinimum++;
      continue;
    }
    const key = `${file.show}/${file.episodeId}`;
    let c = episodes.get(key);
    if (!c) {
      c = { ...emptyCounts(), ...file };
      episodes.set(key, c);
    }
    if (ua.server) {
      c.serverDownloads++;
      continue;
    }
    c.downloads++;
    c.apps[ua.name] = (c.apps[ua.name] ?? 0) + 1;
    const country = g.country && g.country !== '-' ? g.country.toUpperCase() : 'Unknown';
    c.countries[country] = (c.countries[country] ?? 0) + 1;
    const device = ua.deviceCategory ?? 'unknown';
    c.devices[device] = (c.devices[device] ?? 0) + 1;
  }
  return { episodes, filtered };
}
