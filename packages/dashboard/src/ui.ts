import type { BrandSummary, ScheduleEntry, SeriesResponse } from './api';
import type { RuntimeConfig } from './auth';
import { barList, lineChart } from './charts';
import {
  compact,
  countryName,
  deviceName,
  duration,
  fillDays,
  formatName,
  podcastApps,
  shortDate,
  slotTime,
  stateNote,
  topEntries,
} from './format';

export const RANGES = [7, 30, 90, 365];

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export function link(href: string, text: string) {
  const a = el('a', text);
  a.href = href;
  return a;
}

/** A labelled control, with an optional line of help under it. */
export function field(label: string, control: HTMLElement, hint?: string) {
  const wrap = el('label', undefined, 'field');
  wrap.append(el('span', label, 'field-label'), control);
  if (hint) wrap.append(el('span', hint, 'field-hint'));
  return wrap;
}

export function scroller(child: HTMLElement) {
  const div = el('div', undefined, 'scroll-x');
  div.append(child);
  return div;
}

export function card(title: string, body: HTMLElement, subtitle?: string) {
  const section = el('section', undefined, 'card');
  section.append(el('h2', title));
  if (subtitle) section.append(el('p', subtitle, 'muted'));
  section.append(body);
  return section;
}

export function stat(
  label: string,
  value: number | string,
  notes: (string | undefined)[] = [],
  hero = false,
) {
  const tile = el('div', undefined, hero ? 'stat hero' : 'stat');
  const text = typeof value === 'number' ? compact(value) : value;
  tile.append(el('span', label, 'stat-label'), el('span', text, 'stat-value'));
  if (typeof value === 'number') {
    tile.lastElementChild!.setAttribute('title', value.toLocaleString('en-US'));
  }
  for (const note of notes) if (note) tile.append(el('span', note, 'stat-note'));
  return tile;
}

export function timeStat(seconds: number) {
  const tile = el('div', undefined, 'stat');
  tile.append(
    el('span', 'Time watched or listened', 'stat-label'),
    el('span', duration(seconds), 'stat-value'),
  );
  tile.append(el('span', 'Where the platform reports it (YouTube)', 'stat-note'));
  return tile;
}

export function serverNote(n: number) {
  return n ? `Plus ${compact(n)} by self-hosted servers (downloads, not listens)` : undefined;
}

export function crawlerNote(n = 0) {
  return n ? `Includes ${compact(n)} potential crawler downloads` : undefined;
}

export function rangeQuery(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;
}

/** Date range presets: one row above everything they scope. */
export function rangeControl(base: string, days: number) {
  const nav = el('nav', undefined, 'filters');
  nav.setAttribute('aria-label', 'Date range');
  for (const d of RANGES) {
    const a = link(`${base}?days=${d}`, d === 365 ? '12 months' : `${d} days`);
    if (d === days) a.setAttribute('aria-current', 'true');
    nav.append(a);
  }
  return nav;
}

export function rangeLabel(days: number) {
  return days === 365 ? '12 months' : `${days} days`;
}

/** A brand's icon, from the key the ingestion runs record. */
export function brandIcon(config: RuntimeConfig, brand: Partial<BrandSummary>, size = 28) {
  const src =
    brand.iconUrl ??
    (brand.iconKey && config.mediaUrl
      ? `${config.mediaUrl.replace(/\/+$/, '')}/${brand.iconKey}`
      : undefined);
  if (!src) {
    // No icon yet: initials keep the switcher aligned and readable.
    const fallback = el(
      'span',
      (brand.title ?? brand.show ?? '?').slice(0, 1).toUpperCase(),
      'icon icon-text',
    );
    fallback.style.width = fallback.style.height = `${size}px`;
    return fallback;
  }
  const img = el('img', undefined, 'icon');
  img.src = src;
  img.alt = '';
  img.width = img.height = size;
  img.loading = 'lazy';
  return img;
}

/**
 * The brand switcher: every brand the user can see, with its icon. Hidden
 * when there is only one, because then there is nothing to switch to.
 */
export function brandSwitcher(config: RuntimeConfig, brands: BrandSummary[], current?: string) {
  const nav = el('nav', undefined, 'switcher');
  nav.setAttribute('aria-label', 'Brands');
  if (brands.length < 2) return nav;
  for (const brand of brands) {
    const a = link(`#/s/${brand.show}`, '');
    a.className = 'brand-pill';
    a.append(brandIcon(config, brand, 20), el('span', brand.title ?? brand.show));
    if (brand.show === current) a.setAttribute('aria-current', 'true');
    nav.append(a);
  }
  return nav;
}

export function trend(data: SeriesResponse, notBefore?: string) {
  const from = notBefore && notBefore > data.from ? notBefore : data.from;
  const days = fillDays(data.daily, from, data.to, (date) => ({
    date,
    downloads: 0,
    serverDownloads: 0,
  }));
  return card(
    'Plays per day',
    lineChart(
      days.map((d) => ({ date: d.date, value: d.downloads })),
      'Downloads',
    ),
    'Podcast app downloads (unique per listener per day, over one minute, no bots) plus YouTube views.',
  );
}

/**
 * One row per outlet: the feed, each channel, each platform. Outlets replace
 * the older "by source" table; an outlet DarkRelay no longer knows about
 * still appears, named by its source, so no number goes missing.
 */
export function outletsCard(data: SeriesResponse, brand?: string) {
  const rows = data.byOutlet ?? [];
  const table = el('table', undefined, 'sources');
  const head = table.createTHead().insertRow();
  for (const h of ['Outlet', 'Plays', 'Time watched or listened', 'Average per play'])
    head.append(el('th', h));
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    const first = tr.insertCell();
    // A channel has a page of its own; a feed's numbers are the brand page.
    if (brand && row.kind === 'youtube') first.append(link(`#/s/${brand}/o/${row.id}`, row.name));
    else first.textContent = row.name;
    const cells = [
      row.plays.toLocaleString('en-US'),
      row.watchSeconds ? duration(row.watchSeconds) : '—',
      row.watchSeconds && row.plays ? duration(row.watchSeconds / row.plays) : '—',
    ];
    for (const c of cells) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = c;
    }
  }
  return card(
    'By outlet',
    rows.length ? scroller(table) : el('p', 'No data in this range.', 'muted'),
    'Download counts cannot measure listening time; only platforms that play the episode themselves can.',
  );
}

export function breakdowns(data: SeriesResponse) {
  const grid = el('div', undefined, 'grid');
  grid.append(
    card(
      'Podcast apps',
      barList(topEntries(podcastApps(data.bySource ?? [])), 'Downloads by podcast app'),
    ),
    card(
      'Countries',
      barList(topEntries(data.totals.countries), 'Downloads by country', countryName),
    ),
    card(
      'Devices',
      barList(topEntries(data.totals.devices), 'Downloads by device type', deviceName),
    ),
  );
  return grid;
}

/** Shorts against long-form: two numbers that behave nothing alike. */
export function formatSplit(formats: Record<string, { views: number; watchSeconds: number }>) {
  const entries = Object.entries(formats).filter(([, f]) => f.views || f.watchSeconds);
  if (!entries.length) return el('p', 'No data in this range.', 'muted');
  const total = entries.reduce((n, [, f]) => n + f.views, 0);
  const wrap = el('div', undefined, 'splits');
  for (const [name, f] of entries.sort((a, b) => b[1].views - a[1].views)) {
    const row = el('div', undefined, 'split');
    const share = total ? Math.round((f.views / total) * 100) : 0;
    row.append(el('span', formatName(name), 'split-label'));
    const meter = el('div', undefined, 'meter');
    const fill = el('div', undefined, 'meter-fill');
    fill.style.width = `${share}%`;
    meter.append(fill);
    row.append(meter);
    row.append(
      el(
        'span',
        `${compact(f.views)} views · ${duration(f.watchSeconds)} · ${share}%`,
        'split-num',
      ),
    );
    wrap.append(row);
  }
  return wrap;
}

/** Badge words for an item that has not gone live yet. */
const SCHEDULE_WORD: Record<string, string> = {
  planned: 'Scheduled',
  scheduled: 'Scheduled',
  uploading: 'Uploading',
  failed: 'Failed',
  private: 'Private',
  unlisted: 'Unlisted',
};

/** States that are only waiting for a clock, so a date completes them. */
const AWAITING_SLOT = new Set(['planned', 'scheduled']);

/**
 * "Scheduled · Nov 20, 6:00 PM" — when an item goes live, beside its title.
 * `planned` and `scheduled` both read as "Scheduled" because the difference
 * (whether the bytes are on YouTube yet) is DarkRelay's business, not the
 * reader's; the full sentence is in the tooltip for when it is.
 */
export function scheduleBadge(item: Pick<ScheduleEntry, 'state' | 'publishAt' | 'error'>) {
  const state = item.state ?? 'planned';
  const word = SCHEDULE_WORD[state] ?? formatName(state);
  // A date where there is one. Waiting for a slot says so, rather than
  // reading as scheduled for a time nobody has chosen.
  const text = item.publishAt
    ? `${word} · ${slotTime(item.publishAt)}`
    : AWAITING_SLOT.has(state)
      ? 'No slot yet'
      : word;
  const badge = el('span', text, `badge ${BADGE_CLASS[state] ?? 'scheduled'}`);
  badge.title = stateNote(item);
  return badge;
}

/** Red for a failure, grey for merely out of sight, blue for a time ahead. */
const BADGE_CLASS: Record<string, string> = {
  failed: 'failed',
  private: 'held',
  unlisted: 'held',
};

export interface VideoTableOptions {
  days: number;
  /** Items with a slot that the analytics rows do not know about yet. */
  pending?: ScheduleEntry[];
  /** By platform id: a video that exists but is still waiting for its time. */
  waiting?: Map<string, ScheduleEntry>;
  /** The format this table is about; a row of any other format gets a tag. */
  format?: string;
  now?: Date;
}

export function videosTable(brand: string, videos: VideoRow[], opts: VideoTableOptions) {
  const { days, pending = [], waiting, format, now = new Date() } = opts;
  const table = el('table', undefined, 'episodes');
  const head = table.createTHead().insertRow();
  for (const h of ['Video', 'Published', 'First 7 days', 'All time']) head.append(el('th', h));
  const body = table.createTBody();

  // What is coming sits above what has gone out, soonest first: the point of
  // a schedule is the next thing, not the last one.
  const soonest = [...pending].sort((a, b) =>
    (a.publishAt ?? '￿').localeCompare(b.publishAt ?? '￿'),
  );
  for (const item of soonest) {
    const tr = body.insertRow();
    tr.className = item.state === 'failed' ? 'pending failed' : 'pending';
    const first = tr.insertCell();
    first.append(el('span', item.title), scheduleBadge(item));
    tr.insertCell().textContent = item.publishAt ? slotTime(item.publishAt) : '—';
    // Nothing to count yet, and a zero would read as a flop rather than as
    // a video that has not happened.
    for (let i = 0; i < 2; i++) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = '—';
    }
  }

  for (const v of videos) {
    const tr = body.insertRow();
    const first = tr.insertCell();
    first.append(link(`#/s/${brand}/v/${v.videoId}?days=${days}`, v.title));
    if (!format || v.format !== format) first.append(el('span', formatName(v.format), 'tag'));
    const scheduled = pendingFor(v, waiting, now);
    if (scheduled) first.append(scheduleBadge(scheduled));
    tr.insertCell().textContent = scheduled?.publishAt
      ? slotTime(scheduled.publishAt)
      : v.publishedAt
        ? shortDate(v.publishedAt)
        : '—';
    for (const n of [v.downloads7 ?? 0, v.downloadsTotal ?? 0]) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = n.toLocaleString('en-US');
    }
  }
  return table;
}

/**
 * Whether a recorded video is still waiting to go public, and what to say
 * about it. The content store is the honest answer where DarkRelay scheduled
 * the item itself; a publish date in the future is the fallback, so a video
 * scheduled in YouTube Studio is not shown as though it were already out.
 */
export function pendingFor(
  v: VideoRow,
  waiting?: Map<string, ScheduleEntry>,
  now = new Date(),
): Pick<ScheduleEntry, 'state' | 'publishAt' | 'error'> | undefined {
  const known = waiting?.get(v.videoId);
  if (known) return known;
  const held = v.privacyStatus && v.privacyStatus !== 'public' ? v.privacyStatus : undefined;
  // `scheduledAt` is the release time the platform is holding, so it answers
  // this on its own; `publishedAt` is the upload time and would call a video
  // scheduled for next week one that went out the day it was uploaded.
  if (v.scheduledAt && (held || Date.parse(v.scheduledAt) > now.getTime())) {
    return { state: 'scheduled', publishAt: v.scheduledAt };
  }
  if (held) return { state: held };
  if (v.publishedAt && Date.parse(v.publishedAt) > now.getTime()) {
    return { state: 'scheduled', publishAt: v.publishedAt };
  }
  return undefined;
}

/**
 * A channel's content as two cards: Videos and Shorts. They are different
 * products on the same channel — a Short is found in a feed, a long video is
 * chosen — so one table of both hides how either is doing. Each card lists
 * what is scheduled above what is out, with the date it goes live.
 */
export function videoCards(
  brand: string,
  videos: VideoRow[],
  days: number,
  scheduled: ScheduleEntry[] = [],
  now = new Date(),
): HTMLElement[] {
  const recorded = new Set(videos.map((v) => v.videoId));
  // An item DarkRelay already has analytics rows for is not listed twice:
  // that row gets the badge instead.
  const pending = scheduled.filter(
    (e) => e.state !== 'published' && !(e.externalId && recorded.has(e.externalId)),
  );
  const waiting = new Map(
    scheduled
      .filter((e) => e.state !== 'published' && e.externalId && recorded.has(e.externalId))
      .map((e) => [e.externalId!, e]),
  );
  const isShort = (format: string) => format === 'short';
  const sections = [
    {
      title: 'Videos',
      subtitle: 'Long-form video on the channel that is not an episode of the feed.',
      format: 'long',
      rows: videos.filter((v) => !isShort(v.format)),
      pending: pending.filter((e) => e.kind !== 'short'),
    },
    {
      title: 'Shorts',
      subtitle: 'Vertical Shorts, which the Shorts feed finds for people rather than being chosen.',
      format: 'short',
      rows: videos.filter((v) => isShort(v.format)),
      pending: pending.filter((e) => e.kind === 'short'),
    },
  ];
  return sections
    .filter((s) => s.rows.length || s.pending.length)
    .map((s) =>
      card(
        s.title,
        scroller(
          videosTable(brand, s.rows, {
            days,
            pending: s.pending,
            waiting,
            format: s.format,
            now,
          }),
        ),
        s.subtitle,
      ),
    );
}

/**
 * What a channel has coming: content with a slot, plus recorded videos the
 * platform has not made public yet. The stats row says this so a page
 * answers "what is next" without scrolling to find out.
 */
export function countPending(
  videos: VideoRow[],
  scheduled: ScheduleEntry[] = [],
  now = new Date(),
): { count: number; next?: string } {
  const recorded = new Set(videos.map((v) => v.videoId));
  const fromContent = scheduled.filter(
    (e) => e.state !== 'published' && !(e.externalId && recorded.has(e.externalId)),
  );
  const fromChannel = videos
    .map((v) => pendingFor(v, undefined, now))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  const dates = [...fromContent, ...fromChannel]
    .map((p) => p.publishAt)
    .filter((d): d is string => Boolean(d))
    .sort();
  return { count: fromContent.length + fromChannel.length, next: dates[0] };
}

/** How many of a brand's recorded videos are Shorts, for the stats row. */
export function countFormats(videos: VideoRow[]) {
  const shorts = videos.filter((v) => v.format === 'short').length;
  return { shorts, long: videos.length - shorts };
}

export interface VideoRow {
  videoId: string;
  title: string;
  /** When it was uploaded — not when a scheduled video goes live. */
  publishedAt: string;
  format: string;
  privacyStatus?: string;
  scheduledAt?: string;
  downloads7?: number;
  downloadsTotal?: number;
}
