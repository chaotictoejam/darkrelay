import {
  get,
  type EpisodeResponse,
  type SeriesResponse,
  type ShowResponse,
  type ShowsResponse,
} from './api';
import { completeSignIn, currentToken, signIn, signOut, type RuntimeConfig } from './auth';
import { barList, lineChart } from './charts';
import { compact, countryName, deviceName, fillDays, shortDate, topEntries } from './format';

const app = document.getElementById('app')!;
const RANGES = [7, 30, 90, 365];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function link(href: string, text: string) {
  const a = el('a', text);
  a.href = href;
  return a;
}

function parseHash() {
  const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?');
  const days = Number(new URLSearchParams(query).get('days'));
  return { parts: path.split('/').filter(Boolean), days: RANGES.includes(days) ? days : 90 };
}

function rangeQuery(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;
}

/** Date range presets: one row above everything they scope. */
function rangeControl(base: string, days: number) {
  const nav = el('nav', undefined, 'filters');
  nav.setAttribute('aria-label', 'Date range');
  for (const d of RANGES) {
    const a = link(`${base}?days=${d}`, d === 365 ? '12 months' : `${d} days`);
    if (d === days) a.setAttribute('aria-current', 'true');
    nav.append(a);
  }
  return nav;
}

function stat(label: string, value: number, note?: string, hero = false) {
  const tile = el('div', undefined, hero ? 'stat hero' : 'stat');
  tile.append(el('span', label, 'stat-label'), el('span', compact(value), 'stat-value'));
  tile.lastElementChild!.setAttribute('title', value.toLocaleString('en-US'));
  if (note) tile.append(el('span', note, 'stat-note'));
  return tile;
}

function scroller(child: HTMLElement) {
  const div = el('div', undefined, 'scroll-x');
  div.append(child);
  return div;
}

function card(title: string, body: HTMLElement, subtitle?: string) {
  const section = el('section', undefined, 'card');
  section.append(el('h2', title));
  if (subtitle) section.append(el('p', subtitle, 'muted'));
  section.append(body);
  return section;
}

function breakdowns(data: SeriesResponse) {
  const grid = el('div', undefined, 'grid');
  grid.append(
    card('Apps', barList(topEntries(data.totals.apps), 'Downloads by app')),
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

function trend(data: SeriesResponse, notBefore?: string) {
  const from = notBefore && notBefore > data.from ? notBefore : data.from;
  const days = fillDays(data.daily, from, data.to, (date) => ({
    date,
    downloads: 0,
    serverDownloads: 0,
  }));
  return card(
    'Downloads per day',
    lineChart(
      days.map((d) => ({ date: d.date, value: d.downloads })),
      'Downloads',
    ),
    'Unique listeners per episode per day, over one minute of audio, bots removed.',
  );
}

function serverNote(n: number) {
  return n ? `Plus ${compact(n)} by self-hosted servers (downloads, not listens)` : undefined;
}

async function showList(config: RuntimeConfig) {
  const data = await get<ShowsResponse>(config, '/shows');
  if (data.shows.length === 1) {
    location.replace(`#/s/${data.shows[0]!.show}`);
    return;
  }
  const list = el('ul', undefined, 'shows');
  for (const s of data.shows) {
    const li = el('li');
    li.append(link(`#/s/${s.show}`, s.title));
    list.append(li);
  }
  app.replaceChildren(
    el('h1', 'Shows'),
    data.shows.length
      ? list
      : el(
          'p',
          'No downloads counted yet. Data appears the morning after the first downloads.',
          'muted',
        ),
  );
}

async function showView(config: RuntimeConfig, show: string, days: number) {
  const data = await get<ShowResponse>(config, `/shows/${show}?${rangeQuery(days)}`);
  const title = el('h1', show);
  get<ShowsResponse>(config, '/shows')
    .then((s) => (title.textContent = s.shows.find((x) => x.show === show)?.title ?? show))
    .catch(() => {});

  const stats = el('div', undefined, 'stats');
  stats.append(
    stat(
      `Downloads, last ${days === 365 ? '12 months' : `${days} days`}`,
      data.totals.downloads,
      serverNote(data.totals.serverDownloads),
      true,
    ),
    stat('Episodes', data.episodes.length),
  );

  const table = el('table', undefined, 'episodes');
  const head = table.createTHead().insertRow();
  for (const h of [
    'Episode',
    'Released',
    'First 7 days',
    'First 30 days',
    'First 90 days',
    'All time',
  ]) {
    head.append(el('th', h));
  }
  const body = table.createTBody();
  for (const e of data.episodes) {
    const tr = body.insertRow();
    tr.insertCell().append(link(`#/s/${show}/e/${e.episodeId}?days=${days}`, e.title));
    tr.insertCell().textContent = shortDate(e.pubDate);
    for (const n of [e.downloads7, e.downloads30, e.downloads90, e.downloadsTotal]) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = n.toLocaleString('en-US');
    }
  }

  app.replaceChildren(
    title,
    rangeControl(`#/s/${show}`, days),
    stats,
    trend(data),
    breakdowns(data),
    card(
      'Episodes',
      data.episodes.length ? scroller(table) : el('p', 'No episode data yet.', 'muted'),
      'Downloads in the first days after release, all sources.',
    ),
  );
}

async function episodeView(config: RuntimeConfig, show: string, id: string, days: number) {
  const data = await get<EpisodeResponse>(
    config,
    `/shows/${show}/episodes/${id}?${rangeQuery(days)}`,
  );
  const e = data.episode;
  const back = link(`#/s/${show}?days=${days}`, '← All episodes');
  back.className = 'back';
  const stats = el('div', undefined, 'stats');
  stats.append(
    stat('All time', e.downloadsTotal, serverNote(e.serverTotal), true),
    stat('First 7 days', e.downloads7),
    stat('First 30 days', e.downloads30),
    stat('First 90 days', e.downloads90),
  );
  app.replaceChildren(
    back,
    el('h1', e.title),
    el('p', `Released ${shortDate(e.pubDate)}`, 'muted'),
    rangeControl(`#/s/${show}/e/${id}`, days),
    stats,
    trend(data, e.pubDate.slice(0, 10)),
    breakdowns(data),
  );
}

async function render(config: RuntimeConfig) {
  const { parts, days } = parseHash();
  app.classList.add('loading');
  try {
    if (parts[0] === 's' && parts[1] && parts[2] === 'e' && parts[3])
      await episodeView(config, parts[1], parts[3], days);
    else if (parts[0] === 's' && parts[1]) await showView(config, parts[1], days);
    else await showList(config);
  } catch (err) {
    app.replaceChildren(el('p', err instanceof Error ? err.message : String(err), 'error'));
  } finally {
    app.classList.remove('loading');
  }
}

async function freshness(config: RuntimeConfig) {
  const { lastRun } = await get<ShowsResponse>(config, '/shows');
  document.getElementById('freshness')!.textContent = lastRun
    ? `Counted through ${shortDate(lastRun.date)}`
    : 'No data processed yet';
}

async function start() {
  const config = (await (await fetch('/config.json')).json()) as RuntimeConfig;
  await completeSignIn(config);
  if (!currentToken()) return signIn(config);
  const out = document.getElementById('signout')!;
  out.hidden = false;
  out.addEventListener('click', () => signOut(config));
  window.addEventListener('hashchange', () => render(config));
  freshness(config).catch(() => {});
  await render(config);
}

start().catch((err) => app.replaceChildren(el('p', String(err), 'error')));
