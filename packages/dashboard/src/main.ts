import {
  get,
  type BrandSummary,
  type EpisodeResponse,
  type MeResponse,
  type ShowResponse,
  type ShowsResponse,
} from './api';
import { completeSignIn, currentToken, signIn, signOut, type RuntimeConfig } from './auth';
import { shortDate, slotTime } from './format';
import { outletView, videoView } from './outlets';
import {
  RANGES,
  brandIcon,
  brandSwitcher,
  breakdowns,
  card,
  countFormats,
  countPending,
  crawlerNote,
  el,
  link,
  outletsCard,
  rangeControl,
  rangeLabel,
  rangeQuery,
  scroller,
  serverNote,
  stat,
  timeStat,
  trend,
  videoCards,
} from './ui';
import { iconEditor } from './brand-icon';
import { calendarView, pendingContent, slotsView } from './schedule';
import { editView, manageView, uploadView } from './upload';

const app = document.getElementById('app')!;

/** The user's roles, fetched once per page load. */
let mePromise: Promise<MeResponse> | undefined;
const me = (config: RuntimeConfig) => (mePromise ??= get<MeResponse>(config, '/me'));

/** The brand list, fetched once per page load: the switcher needs it everywhere. */
let brandsPromise: Promise<ShowsResponse> | undefined;
const brands = (config: RuntimeConfig) => (brandsPromise ??= get<ShowsResponse>(config, '/shows'));

/** After a brand changes, so the switcher and the brand list show it. */
function forgetBrands() {
  brandsPromise = undefined;
}

function parseHash() {
  const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const days = Number(params.get('days'));
  return {
    parts: path.split('/').filter(Boolean),
    days: RANGES.includes(days) ? days : 90,
    params,
  };
}

/** The switcher lives in the header, so it is there on every page. */
async function renderSwitcher(config: RuntimeConfig, current?: string) {
  const slot = document.getElementById('switcher');
  if (!slot) return;
  const { shows } = await brands(config);
  slot.replaceChildren(brandSwitcher(config, shows, current));
}

async function brandList(config: RuntimeConfig) {
  const [data, roles] = await Promise.all([brands(config), me(config)]);
  if (!roles.admin && !roles.view?.length) {
    app.replaceChildren(
      el('h1', 'Brands'),
      el(
        'p',
        "You don't have access to any brands yet. Ask an admin to give you a role for your brand.",
        'muted',
      ),
    );
    return;
  }
  if (data.shows.length === 1) {
    location.replace(`#/s/${data.shows[0]!.show}`);
    return;
  }
  const list = el('ul', undefined, 'brands');
  for (const b of data.shows) {
    const li = el('li');
    const a = link(`#/s/${b.show}`, '');
    a.append(brandIcon(config, b, 32), el('span', b.title ?? b.show));
    li.append(a);
    const kinds = (b.outlets ?? []).map((o) => o.name).join(' · ');
    if (kinds) li.append(el('p', kinds, 'muted'));
    list.append(li);
  }
  app.replaceChildren(
    el('h1', 'Brands'),
    data.shows.length
      ? list
      : el(
          'p',
          'No data counted yet. Numbers appear the morning after the first downloads or views.',
          'muted',
        ),
  );
}

/** A brand page: every outlet summed, with its episodes and its videos. */
async function brandView(config: RuntimeConfig, brand: string, days: number) {
  const [data, scheduled] = await Promise.all([
    get<ShowResponse>(config, `/brands/${brand}?${rangeQuery(days)}`),
    pendingContent(config, brand),
  ]);
  const heading = el('div', undefined, 'heading');
  const title = el('h1', data.title ?? brand);
  const name = el('div', undefined, 'brand-head');
  name.append(brandIcon(config, data, 36), title);
  heading.append(name);
  me(config)
    .then((roles) => {
      if (!roles.upload.some((s) => s.show === brand)) return;
      // An uploader can replace the icon from here; the icon itself is the picker.
      name.replaceChildren(
        iconEditor(
          config,
          { ...data, show: brand },
          {
            onUpdated: () => {
              forgetBrands();
              renderSwitcher(config, brand).catch(() => {});
            },
          },
        ),
        title,
      );
      const actions = el('div', undefined, 'actions');
      const manage = link(`#/manage/${brand}`, 'Manage episodes');
      manage.className = 'button secondary';
      const up = link(`#/upload/${brand}`, 'Upload episode');
      up.className = 'button';
      actions.append(manage, up);
      heading.append(actions);
    })
    .catch(() => {});

  const stats = el('div', undefined, 'stats');
  stats.append(
    stat(
      `Plays & downloads, last ${rangeLabel(days)}`,
      data.totals.downloads,
      [serverNote(data.totals.serverDownloads), crawlerNote(data.totals.suspectDownloads)],
      true,
    ),
    stat('Episodes', data.episodes.length),
  );
  const formats = countFormats(data.videos ?? []);
  if (formats.long) stats.append(stat('Videos', formats.long));
  if (formats.shorts) stats.append(stat('Shorts', formats.shorts));
  // Counted from both sources: what DarkRelay scheduled, and what the
  // channel is holding back whether DarkRelay scheduled it or not.
  const pending = countPending(data.videos ?? [], scheduled);
  if (pending.count) {
    stats.append(
      stat('Scheduled', pending.count, [
        pending.next ? `Next: ${slotTime(pending.next)}` : undefined,
      ]),
    );
  }
  if (data.totals.watchSeconds) stats.append(timeStat(data.totals.watchSeconds));

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
    tr.insertCell().append(link(`#/s/${brand}/e/${e.episodeId}?days=${days}`, e.title));
    tr.insertCell().textContent = shortDate(e.pubDate);
    for (const n of [e.downloads7, e.downloads30, e.downloads90, e.downloadsTotal]) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = n.toLocaleString('en-US');
    }
  }

  const sections: HTMLElement[] = [
    heading,
    rangeControl(`#/s/${brand}`, days),
    stats,
    trend(data),
    outletsCard(data, brand),
    breakdowns(data),
  ];
  const videos = data.videos ?? [];
  if (data.episodes.length || (!videos.length && !scheduled.length)) {
    sections.push(
      card(
        'Episodes',
        data.episodes.length ? scroller(table) : el('p', 'No episode data yet.', 'muted'),
        'Downloads in the first days after release, all outlets.',
      ),
    );
  }
  sections.push(...videoCards(brand, videos, days, scheduled));
  app.replaceChildren(...sections);
}

async function episodeView(config: RuntimeConfig, brand: string, id: string, days: number) {
  const data = await get<EpisodeResponse>(
    config,
    `/brands/${brand}/episodes/${id}?${rangeQuery(days)}`,
  );
  const e = data.episode;
  const back = link(`#/s/${brand}?days=${days}`, '← All episodes');
  back.className = 'back';
  const stats = el('div', undefined, 'stats');
  stats.append(
    stat(
      'All time',
      e.downloadsTotal,
      [serverNote(e.serverTotal), crawlerNote(e.suspectTotal)],
      true,
    ),
    stat('First 7 days', e.downloads7),
    stat('First 30 days', e.downloads30),
    stat('First 90 days', e.downloads90),
  );
  if (data.totals.watchSeconds) stats.append(timeStat(data.totals.watchSeconds));
  app.replaceChildren(
    back,
    el('h1', e.title),
    el('p', `Released ${shortDate(e.pubDate)}`, 'muted'),
    rangeControl(`#/s/${brand}/e/${id}`, days),
    stats,
    trend(data, e.pubDate.slice(0, 10)),
    outletsCard(data, brand),
    breakdowns(data),
  );
}

/** Which brand the current route is about, for the switcher's current state. */
function currentBrand(parts: string[]): string | undefined {
  if (parts[0] === 's' || parts[0] === 'b') return parts[1];
  if (parts[0] === 'upload' || parts[0] === 'manage') return parts[1];
  if (parts[0] === 'edit') return parts[1];
  return undefined;
}

async function render(config: RuntimeConfig) {
  const { parts, days, params } = parseHash();
  app.classList.add('loading');
  renderSwitcher(config, currentBrand(parts)).catch(() => {});
  try {
    if (parts[0] === 'schedule') await calendarView(app, config);
    else if ((parts[0] === 's' || parts[0] === 'b') && parts[1] && parts[2] === 'slots')
      await slotsView(app, config, parts[1], params.get('plan') ?? undefined);
    else if (parts[0] === 'upload') await uploadView(app, config, parts[1]);
    else if (parts[0] === 'manage' && parts[1]) await manageView(app, config, parts[1]);
    else if (parts[0] === 'edit' && parts[1] && parts[2])
      await editView(app, config, parts[1], parts[2]);
    else if ((parts[0] === 's' || parts[0] === 'b') && parts[1] && parts[2] === 'e' && parts[3])
      await episodeView(config, parts[1], parts[3], days);
    else if ((parts[0] === 's' || parts[0] === 'b') && parts[1] && parts[2] === 'o' && parts[3])
      await outletView(app, config, parts[1], parts[3], days);
    else if ((parts[0] === 's' || parts[0] === 'b') && parts[1] && parts[2] === 'v' && parts[3])
      await videoView(app, config, parts[1], parts[3], days);
    else if ((parts[0] === 's' || parts[0] === 'b') && parts[1])
      await brandView(config, parts[1], days);
    else await brandList(config);
  } catch (err) {
    app.replaceChildren(el('p', err instanceof Error ? err.message : String(err), 'error'));
  } finally {
    app.classList.remove('loading');
  }
}

async function freshness(config: RuntimeConfig) {
  const { lastRun } = await brands(config);
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
  me(config)
    .then((roles) => {
      if (roles.upload.length) document.getElementById('upload')!.hidden = false;
    })
    .catch(() => {});
  window.addEventListener('hashchange', () => render(config));
  freshness(config).catch(() => {});
  await render(config);
}

export type { BrandSummary };

start().catch((err) => app.replaceChildren(el('p', String(err), 'error')));
