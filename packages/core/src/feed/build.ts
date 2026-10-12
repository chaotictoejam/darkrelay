import { feedUrl, resolveAsset } from '../layout';
import type { EpisodeManifest, ShowConfig } from '../model';
import { cdata, el, empty, raw } from '../xml';

export const NAMESPACES = {
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
  podcast: 'https://podcastindex.org/namespace/1.0',
  atom: 'http://www.w3.org/2005/Atom',
  content: 'http://purl.org/rss/1.0/modules/content/',
} as const;

export interface BuildFeedInput {
  show: ShowConfig;
  episodes: EpisodeManifest[];
  /** Public base URL, e.g. https://media.example.com */
  baseUrl: string;
  now?: Date;
}

/** Episodes that belong in the feed right now, newest first. */
export function feedEpisodes(episodes: EpisodeManifest[], now: Date): EpisodeManifest[] {
  return episodes
    .filter((e) => e.status === 'published' && Date.parse(e.pubDate) <= now.getTime())
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

/** When the next scheduled episode goes out, if any. Hidden episodes never do. */
export function nextRelease(episodes: EpisodeManifest[], now: Date): Date | undefined {
  const future = episodes
    .filter((e) => e.status === 'published')
    .map((e) => Date.parse(e.pubDate))
    .filter((t) => t > now.getTime());
  return future.length ? new Date(Math.min(...future)) : undefined;
}

/**
 * Builds the RSS feed. Output is deterministic for the same input (no build
 * timestamp), so callers can skip rewriting and invalidating an unchanged feed.
 */
export function buildFeed({ show, episodes, baseUrl, now = new Date() }: BuildFeedInput): string {
  const url = (a: Parameters<typeof resolveAsset>[0]) => resolveAsset(a, baseUrl);
  const items = feedEpisodes(episodes, now);
  const showImage = url(show.image);
  const self = feedUrl(baseUrl, show.slug);

  const channel = [
    empty('atom:link', { href: self, rel: 'self', type: 'application/rss+xml' }),
    el('title', show.title),
    el('link', show.link),
    raw('description', cdata(show.description)),
    el('language', show.language),
    el('copyright', show.copyright),
    el('generator', 'DarkRelay'),
    items[0] ? el('lastBuildDate', new Date(items[0].pubDate).toUTCString()) : '',
    raw('image', el('url', showImage) + el('title', show.title) + el('link', show.link)),
    el('itunes:author', show.author),
    raw('itunes:owner', el('itunes:name', show.owner.name) + el('itunes:email', show.owner.email)),
    empty('itunes:image', { href: showImage }),
    ...show.categories.map((c) =>
      c.sub
        ? raw('itunes:category', empty('itunes:category', { text: c.sub }), { text: c.text })
        : empty('itunes:category', { text: c.text }),
    ),
    el('itunes:explicit', String(show.explicit)),
    el('itunes:type', show.type),
    el('itunes:new-feed-url', show.newFeedUrl),
    el('podcast:guid', show.podcastGuid),
    el('podcast:locked', show.locked ? 'yes' : 'no', { owner: show.owner.email }),
    el('podcast:medium', 'podcast'),
    ...items.map((e) => buildItem(e, url)),
  ];

  const ns = Object.entries(NAMESPACES)
    .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"${ns}>\n<channel>\n${channel
    .filter(Boolean)
    .join('\n')}\n</channel>\n</rss>\n`;
}

function buildItem(
  e: EpisodeManifest,
  url: (a: Parameters<typeof resolveAsset>[0]) => string,
): string {
  const parts = [
    el('title', e.title),
    raw('description', cdata(e.description)),
    raw('content:encoded', cdata(e.description)),
    el('link', e.link),
    el('guid', e.guid, {
      isPermaLink: e.guidIsPermaLink === undefined ? undefined : String(e.guidIsPermaLink),
    }),
    el('pubDate', new Date(e.pubDate).toUTCString()),
    empty('enclosure', {
      url: url(e.enclosure.asset),
      length: e.enclosure.length,
      type: e.enclosure.type,
    }),
    el('itunes:title', e.title),
    el('itunes:duration', e.durationSeconds),
    el('itunes:episodeType', e.episodeType),
    el('itunes:season', e.season),
    el('itunes:episode', e.episode),
    e.explicit === undefined ? '' : el('itunes:explicit', String(e.explicit)),
    e.image ? empty('itunes:image', { href: url(e.image) }) : '',
    e.keywords.length ? el('itunes:keywords', e.keywords.join(',')) : '',
    ...e.transcripts.map((t) =>
      empty('podcast:transcript', {
        url: url(t.asset),
        type: t.type,
        language: t.language,
        rel: t.rel,
      }),
    ),
    e.chapters
      ? empty('podcast:chapters', { url: url(e.chapters), type: 'application/json+chapters' })
      : '',
    ...e.persons.map((p) =>
      el('podcast:person', p.name, { role: p.role, group: p.group, href: p.href, img: p.img }),
    ),
    el('podcast:season', e.season),
    el('podcast:episode', e.episode),
  ];
  return raw('item', '\n' + parts.filter(Boolean).join('\n') + '\n');
}
