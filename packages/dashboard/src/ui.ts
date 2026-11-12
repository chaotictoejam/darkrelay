import type { BrandSummary, SeriesResponse } from './api';
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

export function videosTable(brand: string, videos: VideoRow[], days: number) {
  const table = el('table', undefined, 'episodes');
  const head = table.createTHead().insertRow();
  for (const h of ['Video', 'Format', 'Published', 'First 7 days', 'All time'])
    head.append(el('th', h));
  const body = table.createTBody();
  for (const v of videos) {
    const tr = body.insertRow();
    tr.insertCell().append(link(`#/s/${brand}/v/${v.videoId}?days=${days}`, v.title));
    tr.insertCell().textContent = formatName(v.format);
    tr.insertCell().textContent = v.publishedAt ? shortDate(v.publishedAt) : '—';
    for (const n of [v.downloads7 ?? 0, v.downloadsTotal ?? 0]) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = n.toLocaleString('en-US');
    }
  }
  return table;
}

export interface VideoRow {
  videoId: string;
  title: string;
  publishedAt: string;
  format: string;
  downloads7?: number;
  downloadsTotal?: number;
}
