import { emptyCounts, type DailyCounts } from './metrics';
import { classifyUserAgent, type UaInfo } from './useragent';

/**
 * One row from the daily query: every request for one file from one
 * IP + User-Agent pair on one UTC day, already summed. The IP itself is
 * never returned.
 */
export interface RequestGroup {
  path: string;
  userAgent: string;
  country?: string;
  /** Autonomous system (network) the request came from. */
  asn?: string;
  /** Distinguishes IPs within one day's query; not the IP and not stable across days. */
  client?: string;
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
 * A network counts as a potential crawler on a day when this many different
 * IPs, all browsers or unrecognised clients, download at least this many
 * different episodes. Real listeners are one IP each, and a group of them on
 * one network does not work through a back catalogue on the same day.
 */
export const CRAWLER_MIN_CLIENTS = 5;
export const CRAWLER_MIN_EPISODES = 5;

/** Podcast apps and players identify themselves; a crawler poses as a browser or nothing. */
const looksLikeCrawler = (ua: UaInfo) => ua.kind === 'browser' || ua.kind === 'unknown';

/** Networks whose browser/unknown downloads look like one crawler spread over many IPs. */
function crawlerNetworks(downloads: { g: RequestGroup; key: string; ua: UaInfo }[]) {
  const byAsn = new Map<string, { clients: Set<string>; episodes: Set<string> }>();
  for (const { g, key, ua } of downloads) {
    if (!looksLikeCrawler(ua)) continue;
    if (!g.asn || g.asn === '-' || !g.client) continue;
    const n = byAsn.get(g.asn) ?? { clients: new Set(), episodes: new Set() };
    n.clients.add(g.client);
    n.episodes.add(key);
    byAsn.set(g.asn, n);
  }
  return new Set(
    [...byAsn]
      .filter(
        ([, n]) => n.clients.size >= CRAWLER_MIN_CLIENTS && n.episodes.size >= CRAWLER_MIN_EPISODES,
      )
      .map(([asn]) => asn),
  );
}

/**
 * IAB 2.2-style counting for one UTC day. Groups arrive already deduped by
 * IP + User-Agent + file (calendar-day window) with byte-range requests summed.
 * Potential crawler downloads still count; they are also tallied separately.
 */
export function countDownloads(
  groups: RequestGroup[],
  factsFor: (file: EpisodeFile) => FileFacts,
): CountResult {
  const episodes = new Map<string, DailyCounts & EpisodeFile>();
  const filtered = { bots: 0, belowMinimum: 0, notAudio: 0 };
  const downloads: { g: RequestGroup; file: EpisodeFile; key: string; ua: UaInfo }[] = [];

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
    downloads.push({ g, file, key: `${file.show}/${file.episodeId}`, ua });
  }

  const crawlers = crawlerNetworks(downloads);
  for (const { g, file, key, ua } of downloads) {
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
    if (g.asn && crawlers.has(g.asn) && looksLikeCrawler(ua)) {
      c.suspectDownloads = (c.suspectDownloads ?? 0) + 1;
    }
    c.apps[ua.name] = (c.apps[ua.name] ?? 0) + 1;
    const country = g.country && g.country !== '-' ? g.country.toUpperCase() : 'Unknown';
    c.countries[country] = (c.countries[country] ?? 0) + 1;
    const device = ua.deviceCategory ?? 'unknown';
    c.devices[device] = (c.devices[device] ?? 0) + 1;
  }
  return { episodes, filtered };
}
