import type { BrandSummary, ScheduleEntry, SeriesResponse, ShowResponse } from './api';
import type { RuntimeConfig } from './auth';
import { barList, lineChart } from './charts';
import {
  compact,
  countryName,
  deviceName,
  duration,
  fillDays,
  formatName,
  outletLabel,
  playsWord,
  podcastApps,
  recordedTo,
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
  // Today has not been counted yet, so the line ends on the last day that was.
  const days = fillDays(data.daily, from, recordedTo(data.daily, data.to, from), (date) => ({
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
 * Outlets with a page of their own: a channel, and a podcast feed. A
 * platform DarkRelay only has a CSV export for has nothing to show beyond
 * the row it is already on.
 */
export function hasOutletPage(kind: string): boolean {
  return kind === 'youtube' || kind === 'rss';
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
    // A channel and a feed each have a page of their own.
    if (brand && hasOutletPage(row.kind)) first.append(link(`#/s/${brand}/o/${row.id}`, row.name));
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

/**
 * Who downloaded it and from where. Every one of these three is counted from
 * podcast download logs — YouTube reports no country, device or app — so
 * they belong to a podcast outlet, not to a brand that has both.
 *
 * `apps` names one outlet's own apps, where the page is about one outlet.
 */
export function breakdowns(data: SeriesResponse, apps?: Record<string, number>) {
  const grid = el('div', undefined, 'grid');
  grid.append(
    card(
      'Podcast apps',
      barList(topEntries(apps ?? podcastApps(data.bySource ?? [])), 'Downloads by podcast app'),
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

/** One thing that has not gone out yet, from either side of the fence. */
export interface UpcomingItem {
  title: string;
  /** `short` or `video`, as the calendar words it. */
  kind: string;
  state: string;
  publishAt?: string;
  error?: string;
  /** Set once the platform has the bytes. */
  videoId?: string;
}

/**
 * A brand's schedule in numbers. `count` is the headline, and it is only
 * what is genuinely still ahead: a slot in the future that has not failed.
 * Everything else is counted apart rather than folded in, because a private
 * video with no release time, a slot that passed yesterday and a failed
 * upload are each a different problem and none of them is "scheduled".
 */
export interface ScheduledSummary {
  /** Items whose slot is still ahead: what the box counts. */
  count: number;
  /** The soonest slot ahead. */
  next?: string;
  /** Those items, soonest first. */
  items: UpcomingItem[];
  /** On the channel, not public, with no release time: private or unlisted. */
  held: number;
  /** Uploads that failed; they are going nowhere until someone looks. */
  failed: number;
  /** Planned, with nobody having chosen a time yet. */
  awaitingSlot: number;
  /** A slot that has passed with the item still not public. */
  overdue: number;
}

export type ScheduleBucket = 'ahead' | 'overdue' | 'held' | 'failed' | 'awaiting';

/** States that mean "on the channel, out of sight" rather than "coming". */
const HELD_STATES = new Set(['private', 'unlisted']);

/**
 * Which of those five an item is. The clock decides, not the word: an item
 * marked `scheduled` whose time was yesterday is not scheduled any more.
 */
export function scheduleBucket(
  item: { state?: string; publishAt?: string },
  now = new Date(),
): ScheduleBucket {
  if (item.state === 'failed') return 'failed';
  if (!item.publishAt) return HELD_STATES.has(item.state ?? '') ? 'held' : 'awaiting';
  return Date.parse(item.publishAt) > now.getTime() ? 'ahead' : 'overdue';
}

/**
 * What a brand has coming, counted from both sides: content DarkRelay
 * scheduled, and videos the channel is holding whether DarkRelay scheduled
 * them or not. An item recorded on both sides is counted once, with the
 * content store's answer preferred because it knows why.
 */
export function countScheduled(
  videos: VideoRow[],
  scheduled: ScheduleEntry[] = [],
  now = new Date(),
): ScheduledSummary {
  const recorded = new Set(videos.map((v) => v.videoId));
  const waiting = new Map(
    scheduled
      .filter((e) => e.state !== 'published' && e.externalId && recorded.has(e.externalId))
      .map((e) => [e.externalId!, e]),
  );
  const candidates: UpcomingItem[] = [];
  for (const e of scheduled) {
    // A published item is out, and one with a video of its own is counted
    // with that video rather than twice.
    if (e.state === 'published') continue;
    if (e.externalId && recorded.has(e.externalId)) continue;
    candidates.push({
      title: e.title,
      kind: e.kind === 'short' ? 'short' : 'video',
      state: e.state ?? 'planned',
      publishAt: e.publishAt,
      error: e.error,
      videoId: e.externalId,
    });
  }
  for (const v of videos) {
    const pending = pendingFor(v, waiting, now);
    if (!pending) continue;
    candidates.push({
      title: v.title,
      kind: v.format === 'short' ? 'short' : 'video',
      state: pending.state ?? 'scheduled',
      publishAt: pending.publishAt,
      error: pending.error,
      videoId: v.videoId,
    });
  }

  const summary: ScheduledSummary = {
    count: 0,
    items: [],
    held: 0,
    failed: 0,
    awaitingSlot: 0,
    overdue: 0,
  };
  const ahead: UpcomingItem[] = [];
  for (const item of candidates) {
    switch (scheduleBucket(item, now)) {
      case 'ahead':
        ahead.push(item);
        break;
      case 'held':
        summary.held++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'awaiting':
        summary.awaitingSlot++;
        break;
      case 'overdue':
        summary.overdue++;
        break;
    }
  }
  ahead.sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
  summary.count = ahead.length;
  summary.items = ahead;
  summary.next = ahead[0]?.publishAt;
  return summary;
}

/** The lines under the count: everything that is not going out on a clock. */
export function scheduleNotes(summary: ScheduledSummary): string[] {
  const notes: string[] = [];
  if (summary.awaitingSlot) notes.push(`${summary.awaitingSlot} waiting for a slot`);
  if (summary.overdue) notes.push(`${summary.overdue} past its slot and still not public`);
  if (summary.held) notes.push(`${summary.held} private or unlisted, with no release time`);
  if (summary.failed) notes.push(`${summary.failed} failed to upload`);
  return notes;
}

/**
 * The schedule box: how many are genuinely coming, when the next one is, and
 * the few after it. What is not coming — held, failed, slotless, overdue —
 * is said underneath rather than counted, so the number can be trusted.
 */
export function scheduledCard(summary: ScheduledSummary, limit = 5): HTMLElement {
  const body = el('div', undefined, 'sched');
  const head = el('div', undefined, 'sched-head');
  head.append(el('span', String(summary.count), 'stat-value'));
  head.append(
    el(
      'span',
      summary.next
        ? `going out · next ${slotTime(summary.next)}`
        : 'nothing with a time ahead of it',
      'muted',
    ),
  );
  body.append(head);

  if (summary.items.length) {
    const list = el('ul', undefined, 'entries');
    for (const item of summary.items.slice(0, limit)) {
      const row = el('li', undefined, 'entry');
      row.append(el('span', slotTime(item.publishAt!), 'entry-time'));
      const detail = el('div', undefined, 'entry-body');
      const title = el('div', undefined, 'entry-title');
      title.append(el('span', item.title), el('span', formatName(item.kind), 'tag'));
      detail.append(title, el('div', stateNote(item), 'muted'));
      row.append(detail);
      list.append(row);
    }
    body.append(list);
    const rest = summary.items.length - limit;
    if (rest > 0) body.append(el('p', `and ${rest} more`, 'muted'));
  }

  const notes = scheduleNotes(summary);
  if (notes.length) body.append(el('p', `Not counted here: ${notes.join(' · ')}.`, 'muted'));

  const actions = el('div', undefined, 'actions');
  const open = link('#/schedule', 'Open the schedule');
  open.className = 'button secondary';
  actions.append(open);
  body.append(actions);
  return card(
    'Scheduled',
    body,
    'Videos and Shorts whose time is still ahead. An episode release is kept by the feed, not here.',
  );
}

/** One outlet as the summary counts it: what it is, and how it did. */
export interface OutletRow {
  id: string;
  kind: string;
  name: string;
  plays: number;
  watchSeconds: number;
}

/**
 * Every outlet the brand has, whether or not it was played in this range.
 * The brand row names them; the totals only know the ones with numbers, and
 * a channel with a quiet 7 days is still a channel.
 */
export function outletRows(data: ShowResponse): OutletRow[] {
  const byId = new Map<string, OutletRow>();
  for (const o of data.outlets ?? []) {
    byId.set(o.id, { id: o.id, kind: o.kind, name: o.name, plays: 0, watchSeconds: 0 });
  }
  for (const t of data.byOutlet ?? []) {
    const known = byId.get(t.id);
    if (known) {
      known.plays = t.plays;
      known.watchSeconds = t.watchSeconds;
    } else {
      byId.set(t.id, {
        id: t.id,
        kind: t.kind,
        name: t.name,
        plays: t.plays,
        watchSeconds: t.watchSeconds,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
}

/**
 * Which videos belong to a channel. A video recorded before outlets existed
 * carries no outlet, and belongs to the only channel there is; where there
 * are two, a video has to say which.
 */
function videosFor(videos: VideoRow[], outletId: string, channels: string[]) {
  return videos.filter((v) =>
    v.outlet ? v.outlet === outletId : channels.length === 1 && channels[0] === outletId,
  );
}

/**
 * The outlets box: one tile per place the brand publishes, each labelled
 * with what it is — YouTube or the podcast — because the numbers mean
 * different things and the names ("My Show", "My Show") do not say which.
 */
export function outletsSummary(data: ShowResponse, brand: string, days: number): HTMLElement {
  const rows = outletRows(data);
  const subtitle =
    'Where this brand publishes. YouTube counts views and podcast apps count downloads, so the two are kept apart.';
  if (!rows.length) {
    return card('Outlets', el('p', 'No outlets recorded yet.', 'muted'), subtitle);
  }
  const videos = data.videos ?? [];
  const channels = rows.filter((r) => r.kind === 'youtube').map((r) => r.id);
  const grid = el('div', undefined, 'outlets');
  for (const row of rows) {
    const tile = el('div', undefined, 'outlet');
    tile.append(el('span', outletLabel(row.kind), `outlet-kind ${row.kind}`));
    const name = el('div', undefined, 'outlet-name');
    // A channel and a feed each have a page of their own: the videos on one,
    // and where the downloads of the other came from.
    if (hasOutletPage(row.kind)) {
      name.append(link(`#/s/${brand}/o/${row.id}?days=${days}`, row.name));
    } else name.append(el('span', row.name));
    tile.append(name);
    tile.append(el('span', compact(row.plays), 'stat-value'));
    const value = tile.lastElementChild!;
    value.setAttribute('title', row.plays.toLocaleString('en-US'));
    tile.append(el('span', `${playsWord(row.kind)}, last ${rangeLabel(days)}`, 'stat-label'));

    const facts: string[] = [];
    if (row.watchSeconds) facts.push(`${duration(row.watchSeconds)} watched`);
    if (row.kind === 'youtube') {
      const counts = countFormats(videosFor(videos, row.id, channels));
      if (counts.long) facts.push(plural(counts.long, 'video'));
      if (counts.shorts) facts.push(plural(counts.shorts, 'Short'));
    } else if (row.kind === 'rss' && data.episodes.length) {
      facts.push(plural(data.episodes.length, 'episode'));
    }
    if (facts.length) tile.append(el('span', facts.join(' · '), 'stat-note'));
    grid.append(tile);
  }
  return card('Outlets', grid, subtitle);
}

function plural(n: number, word: string) {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** How many of a brand's recorded videos are Shorts, for the stats row. */
export function countFormats(videos: VideoRow[]) {
  const shorts = videos.filter((v) => v.format === 'short').length;
  return { shorts, long: videos.length - shorts };
}

export interface VideoRow {
  videoId: string;
  /** Which outlet it is on; absent on rows recorded before outlets existed. */
  outlet?: string;
  title: string;
  /** When it was uploaded — not when a scheduled video goes live. */
  publishedAt: string;
  format: string;
  privacyStatus?: string;
  scheduledAt?: string;
  downloads7?: number;
  downloadsTotal?: number;
}
