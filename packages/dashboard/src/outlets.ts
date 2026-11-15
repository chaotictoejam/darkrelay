import { apiPath } from '@darkrelay/core/routes';
import { get, type OutletResponse, type ShowResponse, type VideoResponse } from './api';
import type { RuntimeConfig } from './auth';
import { barList, lineChart } from './charts';
import {
  compact,
  duration,
  fillDays,
  formatName,
  outletKindName,
  outletLabel,
  playsWord,
  recordedTo,
  shortDate,
  topEntries,
  trafficSourceName,
} from './format';
import {
  breakdowns,
  card,
  crawlerNote,
  el,
  formatSplit,
  link,
  outletsCard,
  pendingFor,
  rangeControl,
  rangeLabel,
  rangeQuery,
  scheduleBadge,
  serverNote,
  stat,
  trend,
  videoCards,
} from './ui';
import { pendingContent } from './schedule';

/**
 * One outlet's page. For a YouTube channel that means the channel's own
 * numbers — subscribers, where views came from, Shorts against long-form —
 * next to what DarkRelay itself accounts for, which is only the content it
 * knows about.
 */
export async function outletView(
  app: HTMLElement,
  config: RuntimeConfig,
  brand: string,
  outletId: string,
  days: number,
) {
  const [data, scheduled] = await Promise.all([
    get<OutletResponse>(config, `${apiPath('outlet', { brand, outletId })}?${rangeQuery(days)}`),
    pendingContent(config, brand, outletId),
  ]);
  const back = link(`#/s/${brand}?days=${days}`, `← ${data.title}`);
  back.className = 'back';

  const channel = data.channel.totals;
  const net = data.channel.subscriberChange;
  const stats = el('div', undefined, 'stats');
  stats.append(
    stat(`Channel views, last ${rangeLabel(days)}`, channel.views ?? 0, [], true),
    stat('Watch time', duration(channel.watchSeconds ?? 0)),
    stat('Subscribers', `${net >= 0 ? '+' : ''}${compact(net)}`, [
      `${compact(channel.subscribersGained ?? 0)} gained, ${compact(
        channel.subscribersLost ?? 0,
      )} lost`,
    ]),
    stat('Plays DarkRelay accounts for', data.content.totals.downloads, [
      'Episodes and videos it knows about',
    ]),
  );

  // The channel's last counted day, not today: a day YouTube has not been
  // asked about yet is not a day with no views.
  const to = recordedTo(data.channel.daily, data.to, data.from);
  const daily = fillDays(data.channel.daily, data.from, to, (date) => ({
    date,
    views: 0,
    watchSeconds: 0,
    subscribersGained: 0,
    subscribersLost: 0,
    trafficSources: {},
    formats: {},
  }));

  const sections: HTMLElement[] = [
    back,
    el('h1', data.outlet.name),
    el('p', `${outletKindName(data.outlet.kind)} · ${data.title}`, 'muted'),
    rangeControl(`#/s/${brand}/o/${outletId}`, days),
    stats,
    card(
      'Channel views per day',
      lineChart(
        daily.map((d) => ({ date: d.date, value: d.views })),
        'Views',
      ),
      'Every view on the channel, including content DarkRelay knows nothing about.',
    ),
    card(
      'Shorts and long-form',
      formatSplit(channel.formats ?? {}),
      'YouTube reports these apart, and they behave nothing alike: a Short is found in a feed, a long video is chosen.',
    ),
    card(
      'Where the views came from',
      barList(
        topEntries(channel.trafficSources ?? {}),
        'Views by traffic source',
        trafficSourceName,
      ),
    ),
  ];

  if (data.channel.daily.some((d) => d.subscribersGained || d.subscribersLost)) {
    sections.push(
      card(
        'Subscribers gained per day',
        lineChart(
          daily.map((d) => ({ date: d.date, value: d.subscribersGained - d.subscribersLost })),
          'Net subscribers',
        ),
        'Gained minus lost, so a day that lost more than it gained dips below zero.',
      ),
    );
  }

  const cards = videoCards(brand, data.videos, days, scheduled);
  if (cards.length) sections.push(...cards);
  else {
    sections.push(
      card(
        'Videos',
        el(
          'p',
          'No videos recorded yet. Read the channel history with: darkrelay youtube backfill ' +
            brand,
          'muted',
        ),
        'Everything on this channel that is not an episode of the feed.',
      ),
    );
  }
  app.replaceChildren(...sections);
}

/**
 * A podcast outlet's page: where its downloads came from. Podcast apps,
 * countries and devices are counted from the feed's own logs and from
 * nothing else — YouTube reports none of the three — so this is where they
 * belong, rather than on a brand page that is mostly a channel.
 */
export async function podcastView(
  app: HTMLElement,
  config: RuntimeConfig,
  brand: string,
  outletId: string,
  days: number,
) {
  const data = await get<ShowResponse>(
    config,
    `${apiPath('brand', { brand })}?${rangeQuery(days)}`,
  );
  const totals = (data.byOutlet ?? []).find((o) => o.id === outletId);
  const named = (data.outlets ?? []).find((o) => o.id === outletId);
  const name = totals?.name ?? named?.name ?? outletId;
  const kind = totals?.kind ?? named?.kind ?? 'rss';
  const back = link(`#/s/${brand}?days=${days}`, `← ${data.title ?? brand}`);
  back.className = 'back';

  const word = playsWord(kind);
  const stats = el('div', undefined, 'stats');
  stats.append(
    stat(
      `${word[0]!.toUpperCase()}${word.slice(1)}, last ${rangeLabel(days)}`,
      totals?.plays ?? 0,
      [serverNote(data.totals.serverDownloads), crawlerNote(data.totals.suspectDownloads)],
      true,
    ),
    stat('Episodes', data.episodes.length),
  );
  if (totals?.watchSeconds) stats.append(stat('Time listened', duration(totals.watchSeconds)));

  const sections: HTMLElement[] = [
    back,
    el('h1', name),
    el('p', `${outletLabel(kind)} · ${data.title ?? brand}`, 'muted'),
    rangeControl(`#/s/${brand}/o/${outletId}`, days),
    stats,
    // The outlet's own apps where it has them; a feed that has recorded
    // nothing yet falls back to every podcast source the brand has.
    breakdowns(data, Object.keys(totals?.apps ?? {}).length ? totals!.apps : undefined),
  ];
  // Countries and devices are not counted per outlet, so a brand with more
  // than one podcast outlet is told whose numbers these are.
  if ((data.byOutlet ?? []).filter((o) => o.kind !== 'youtube').length > 1) {
    sections.push(
      el(
        'p',
        'Countries and devices are counted across every podcast outlet this brand has; only the apps above are this one’s alone.',
        'muted',
      ),
    );
  }
  app.replaceChildren(...sections);
}

/** One video or Short: the same series view an episode gets. */
export async function videoView(
  app: HTMLElement,
  config: RuntimeConfig,
  brand: string,
  videoId: string,
  days: number,
) {
  const data = await get<VideoResponse>(
    config,
    `${apiPath('video', { brand, videoId })}?${rangeQuery(days)}`,
  );
  const v = data.video;
  const back = link(`#/s/${brand}?days=${days}`, '← Back');
  back.className = 'back';
  const stats = el('div', undefined, 'stats');
  stats.append(
    stat('All time', v.downloadsTotal ?? 0, [], true),
    stat('First 7 days', v.downloads7 ?? 0),
    stat('First 30 days', v.downloads30 ?? 0),
  );
  if (data.totals.watchSeconds) {
    stats.append(stat('Watch time', duration(data.totals.watchSeconds)));
  }
  // A video the platform is still holding has not been published, whatever
  // its upload date says: `publishedAt` is when the bytes arrived, so printing
  // it as "published" calls a video scheduled for next week one that is out.
  const waiting = pendingFor(v);
  const facts = [formatName(v.format)];
  if (!waiting && v.publishedAt) facts.push(`published ${shortDate(v.publishedAt)}`);
  if (v.durationSeconds) facts.push(duration(v.durationSeconds));
  const heading = el('h1', v.title);
  if (waiting) heading.append(scheduleBadge(waiting));
  const watch = link(
    `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`,
    'Watch on YouTube',
  );
  watch.target = '_blank';
  watch.rel = 'noreferrer';
  app.replaceChildren(
    back,
    heading,
    el('p', facts.join(' · '), 'muted'),
    rangeControl(`#/s/${brand}/v/${videoId}`, days),
    stats,
    trend(data, v.publishedAt?.slice(0, 10)),
    outletsCard(data, brand),
    // No podcast app, country or device breakdown here: a video is watched
    // on YouTube, which reports none of the three, so the cards could only
    // ever say "no data in this range".
    el('p', '', 'muted'),
  );
  app.lastElementChild!.append(watch);
}
