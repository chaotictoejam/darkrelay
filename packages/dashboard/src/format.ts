/** 1,284 / 12.9K / 1.2M */
export function compact(n: number): string {
  if (Math.abs(n) < 1000) return n.toLocaleString('en-US');
  if (Math.abs(n) < 1_000_000) return `${trim(n / 1000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(n: number) {
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
}

export function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "Nov 20, 6:00 PM" — a publish slot, in the reader's own time zone. A slot
 * is a moment, not a day, so unlike `shortDate` it keeps the clock and is
 * never forced into UTC: the person reading wants to know when they will be
 * awake for it.
 */
export function slotTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** What an item's publication state means, said plainly. */
export function stateNote(item: { state?: string; error?: string }): string {
  switch (item.state) {
    case 'published':
      return 'live';
    case 'scheduled':
      // The release time is set on YouTube, not merely wished for here:
      // "waiting for its time" read as though nobody had chosen one yet.
      return 'scheduled on YouTube';
    case 'uploading':
      return 'uploading now';
    case 'failed':
      return `failed: ${item.error ?? 'unknown error'}`;
    case 'private':
      return 'on the channel, not public and with no release time set';
    case 'unlisted':
      return 'unlisted: only people with the link can watch it';
    default:
      return 'not uploaded yet';
  }
}

/** Every day from `from` to `to` inclusive, so missing days plot as zero. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Where a series really ends. A day nobody has counted yet has no row at all,
 * and filling it in as a zero draws a cliff to the floor: it reads as the day
 * the audience vanished, when it is only the day the night's run has not
 * reached. So the line stops at the last day there is an answer for.
 *
 * The range's own end is kept where there is nothing recorded in it at all,
 * or nothing since `from`, because an empty chart says less than a flat one.
 */
export function recordedTo<T extends { date: string }>(
  rows: T[],
  to: string,
  from?: string,
): string {
  let last: string | undefined;
  for (const row of rows) if (!last || row.date > last) last = row.date;
  if (!last || last >= to) return to;
  if (from && last < from) return to;
  return last;
}

export function fillDays<T extends { date: string }>(
  rows: T[],
  from: string,
  to: string,
  empty: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return daysBetween(from, to).map((d) => byDate.get(d) ?? empty(d));
}

/** Clean axis maximum and ticks: 0 / 5 / 10, 0 / 1K / 2K. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Top entries of a count map, the rest folded into "Other". */
export function topEntries(map: Record<string, number>, limit = 8): [string, number][] {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit - 1).reduce((n, [, v]) => n + v, 0);
  return [...sorted.slice(0, limit - 1), ['Other', rest]];
}

const COUNTRY =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : undefined;

export function countryName(code: string): string {
  if (code === 'Unknown' || code === 'Other') return code;
  try {
    return COUNTRY?.of(code) ?? code;
  } catch {
    return code;
  }
}

const DEVICES: Record<string, string> = {
  mobile: 'Phone or tablet',
  computer: 'Computer',
  smart_speaker: 'Smart speaker',
  smart_tv: 'Smart TV',
  watch: 'Watch',
  auto: 'Car',
  unknown: 'Unknown',
};

export function deviceName(category: string): string {
  return DEVICES[category] ?? category.replace(/_/g, ' ');
}

/** 2m 24s / 1h 30m / 12h */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 10) return `${h}h`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

const SOURCES: Record<string, string> = {
  cloudfront: 'Podcast apps (downloads)',
  prefix: 'Podcast apps (via prefix)',
  youtube: 'YouTube (views)',
  'apple-csv': 'Apple Podcasts',
  'spotify-csv': 'Spotify',
};

/** Sources counted from RSS downloads, where "app" means the listener's podcast app. */
const DOWNLOAD_SOURCES = new Set(['cloudfront', 'prefix']);

/** Downloads by podcast app, leaving out platforms (YouTube views, CSV exports). */
export function podcastApps(
  bySource: { source: string; apps?: Record<string, number> }[],
): Record<string, number> {
  const apps: Record<string, number> = {};
  for (const s of bySource) {
    if (!DOWNLOAD_SOURCES.has(s.source)) continue;
    for (const [name, n] of Object.entries(s.apps ?? {})) apps[name] = (apps[name] ?? 0) + n;
  }
  return apps;
}

export function sourceName(source: string): string {
  return SOURCES[source] ?? source;
}

/** `insightTrafficSourceType` codes, as YouTube Studio words them. */
const TRAFFIC: Record<string, string> = {
  SHORTS: 'Shorts feed',
  SHORTS_FEED: 'Shorts feed',
  SUBSCRIBER: 'Subscriptions and home',
  YT_SEARCH: 'YouTube search',
  RELATED_VIDEO: 'Suggested videos',
  EXT_URL: 'External sites',
  PLAYLIST: 'Playlists',
  YT_PLAYLIST_PAGE: 'Playlist pages',
  YT_CHANNEL: 'Channel pages',
  NOTIFICATION: 'Notifications',
  END_SCREEN: 'End screens',
  ANNOTATION: 'Cards and annotations',
  NO_LINK_EMBEDDED: 'Embedded players',
  NO_LINK_OTHER: 'Direct or unknown',
  ADVERTISING: 'Advertising',
  CAMPAIGN_CARD: 'Campaign cards',
  PROMOTED: 'Promoted',
  HASHTAGS: 'Hashtag pages',
  SOUND_PAGE: 'Sound pages',
  YT_OTHER_PAGE: 'Other YouTube pages',
  UNKNOWN: 'Unknown',
};

export function trafficSourceName(code: string): string {
  return TRAFFIC[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

const FORMATS: Record<string, string> = {
  short: 'Shorts',
  long: 'Long-form',
  live: 'Live streams',
  other: 'Other',
  video: 'Video',
};

export function formatName(format: string): string {
  return FORMATS[format] ?? format;
}

/** Outlet kinds, for a page heading. */
const OUTLET_KINDS: Record<string, string> = {
  rss: 'RSS feed',
  youtube: 'YouTube channel',
  spotify: 'Spotify',
  apple: 'Apple Podcasts',
};

export function outletKindName(kind: string): string {
  return OUTLET_KINDS[kind] ?? kind;
}

/**
 * What an outlet is, in two or three words, for a summary that has to say
 * which numbers are YouTube's and which are the podcast's. Spotify and Apple
 * are podcast platforms, so they say so rather than standing alone and
 * leaving the reader to know it.
 */
const OUTLET_LABELS: Record<string, string> = {
  rss: 'Podcast',
  youtube: 'YouTube',
  spotify: 'Podcast · Spotify',
  apple: 'Podcast · Apple',
};

export function outletLabel(kind: string): string {
  return OUTLET_LABELS[kind] ?? outletKindName(kind);
}

/** What one play is called on that outlet: a view, a download, a play. */
export function playsWord(kind: string): string {
  if (kind === 'youtube') return 'views';
  if (kind === 'rss') return 'downloads';
  return 'plays';
}
