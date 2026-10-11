import { podcastGuidFromFeedUrl } from '../guid';
import {
  EpisodeManifest,
  ShowConfig,
  type EpisodeManifestInput,
  type Person,
  type ShowConfigInput,
} from '../model';
import { attr, isNode, list, parseFeedXml, text, type XmlNode } from './parse';

export interface ImportOptions {
  /** The URL the feed was fetched from. Used for the show GUID if the feed has none. */
  sourceUrl: string;
  slug: string;
  /** Overrides for channel fields the source feed lacks (e.g. owner email). */
  overrides?: Partial<ShowConfigInput>;
  now?: Date;
}

export interface ImportResult {
  show: ShowConfig;
  episodes: EpisodeManifest[];
  warnings: string[];
}

export class ImportError extends Error {}

/**
 * Converts an existing feed into a draft show plus episode manifests. Media
 * stays where it is (remote URLs); `migrate-media` moves it later. Episode
 * GUIDs and the show GUID are preserved exactly.
 */
export function importFeed(xml: string, opts: ImportOptions): ImportResult {
  const { channel: ch, items } = parseFeedXml(xml);
  const warnings: string[] = [];
  const now = (opts.now ?? new Date()).toISOString();

  const declaredGuid = text(ch['podcast:guid']);
  const podcastGuid = declaredGuid ?? podcastGuidFromFeedUrl(opts.sourceUrl);
  if (!declaredGuid)
    warnings.push(
      `Feed has no <podcast:guid>; using ${podcastGuid}, derived from ${opts.sourceUrl} as the spec requires.`,
    );

  const lockedText = text(ch['podcast:locked']);
  const sourceLocked = lockedText === undefined ? undefined : lockedText === 'yes';
  if (sourceLocked)
    warnings.push(
      'Source feed is <podcast:locked>yes</podcast:locked>. Unlock it at the old host before cutover or apps will refuse the move.',
    );

  const owner = isNode(ch['itunes:owner']) ? ch['itunes:owner'] : {};
  const imageHref =
    attr(ch['itunes:image'], 'href') ?? text(isNode(ch['image']) ? ch['image']['url'] : undefined);

  const showInput: ShowConfigInput = {
    schemaVersion: 1,
    slug: opts.slug,
    status: 'draft',
    title: text(ch['title']) ?? '',
    description: text(ch['description']) ?? text(ch['itunes:summary']) ?? '',
    link: text(ch['link']) ?? opts.sourceUrl,
    language: text(ch['language']) ?? 'en',
    author: text(ch['itunes:author']) ?? text(owner['itunes:name']) ?? '',
    owner: {
      name: text(owner['itunes:name']) ?? text(ch['itunes:author']) ?? '',
      email: text(owner['itunes:email']) ?? '',
    },
    image: { url: imageHref ?? '' },
    categories: list(ch['itunes:category']).map((c) => ({
      text: attr(c, 'text') ?? '',
      sub: attr(isNode(c) ? c['itunes:category'] : undefined, 'text'),
    })),
    explicit: parseExplicit(text(ch['itunes:explicit'])) ?? false,
    type: text(ch['itunes:type']) === 'serial' ? 'serial' : 'episodic',
    copyright: text(ch['copyright']),
    podcastGuid,
    locked: true,
    podcastIndexNotify: false,
    source: { feedUrl: opts.sourceUrl, importedAt: now, locked: sourceLocked },
    ...opts.overrides,
  };
  if (!text(ch['language'])) warnings.push('Feed has no <language>; assumed "en".');

  const showParsed = ShowConfig.safeParse(showInput);
  if (!showParsed.success) {
    const issues = showParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ImportError(
      `Show fields missing or invalid (pass them as overrides):\n  ${issues.join('\n  ')}`,
    );
  }

  const episodes: EpisodeManifest[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const ep = importItem(item, i, now, warnings);
    if (!ep) return;
    if (seen.has(ep.guid)) {
      warnings.push(`item[${i}]: duplicate guid "${ep.guid}" skipped; the first one wins.`);
      return;
    }
    seen.add(ep.guid);
    episodes.push(ep);
  });

  return { show: showParsed.data, episodes, warnings };
}

function importItem(
  item: XmlNode,
  i: number,
  now: string,
  warnings: string[],
): EpisodeManifest | undefined {
  const title = text(item['title']) ?? text(item['itunes:title']) ?? `item ${i}`;
  const enc = item['enclosure'];
  const encUrl = attr(enc, 'url');
  if (!encUrl) {
    warnings.push(`"${title}": no enclosure, skipped.`);
    return undefined;
  }

  let guid = text(item['guid']);
  let guidIsPermaLink: boolean | undefined;
  const permaAttr = attr(item['guid'], 'isPermaLink');
  if (permaAttr !== undefined) guidIsPermaLink = permaAttr === 'true';
  if (!guid) {
    // Apps fall back to the enclosure URL; keep that as the identity.
    guid = encUrl;
    guidIsPermaLink = false;
    warnings.push(
      `"${title}": no <guid>; using the enclosure URL, which is what apps already use.`,
    );
  }

  const pubDateText = text(item['pubDate']);
  const pubMs = pubDateText ? Date.parse(pubDateText) : NaN;
  if (Number.isNaN(pubMs)) {
    warnings.push(`"${title}": missing or invalid pubDate "${pubDateText ?? ''}", skipped.`);
    return undefined;
  }

  const lengthText = attr(enc, 'length');
  const length = lengthText && /^\d+$/.test(lengthText) ? Number(lengthText) : 0;
  if (length === 0) warnings.push(`"${title}": enclosure length missing or 0.`);

  const chaptersUrl = attr(item['podcast:chapters'], 'url');
  const image = attr(item['itunes:image'], 'href');
  const episodeType = text(item['itunes:episodeType']);

  const input: EpisodeManifestInput = {
    schemaVersion: 1,
    guid,
    guidIsPermaLink,
    status: 'published',
    title,
    description:
      text(item['content:encoded']) ??
      text(item['description']) ??
      text(item['itunes:summary']) ??
      '',
    link: validUrl(text(item['link'])),
    pubDate: new Date(pubMs).toISOString(),
    durationSeconds: parseDuration(text(item['itunes:duration'])),
    episodeType: episodeType === 'trailer' || episodeType === 'bonus' ? episodeType : 'full',
    season: positiveInt(text(item['itunes:season'])),
    episode: positiveInt(text(item['itunes:episode'])),
    explicit: parseExplicit(text(item['itunes:explicit'])),
    image: image ? { url: image } : undefined,
    enclosure: { asset: { url: encUrl }, length, type: attr(enc, 'type') ?? 'audio/mpeg' },
    transcripts: list(item['podcast:transcript']).flatMap((t) => {
      const url = attr(t, 'url');
      const type = attr(t, 'type');
      return url && type
        ? [{ asset: { url }, type, language: attr(t, 'language'), rel: attr(t, 'rel') }]
        : [];
    }),
    chapters: chaptersUrl ? { url: chaptersUrl } : undefined,
    persons: list(item['podcast:person']).flatMap((p): Person[] => {
      const name = text(p);
      return name
        ? [
            {
              name,
              role: attr(p, 'role'),
              group: attr(p, 'group'),
              href: validUrl(attr(p, 'href')),
              img: validUrl(attr(p, 'img')),
            },
          ]
        : [];
    }),
    keywords: (text(item['itunes:keywords']) ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    updatedAt: now,
  };

  const parsed = EpisodeManifest.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
    warnings.push(`"${title}": invalid (${issues}), skipped.`);
    return undefined;
  }
  return parsed.data;
}

export function parseDuration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const parts = v.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined;
  return Math.round(parts.reduce((acc, p) => acc * 60 + Number(p), 0));
}

function parseExplicit(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'explicit') return true;
  if (s === 'false' || s === 'no' || s === 'clean') return false;
  return undefined;
}

function positiveInt(v: string | undefined): number | undefined {
  if (!v || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 ? n : undefined;
}

function validUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    new URL(v);
    return v;
  } catch {
    return undefined;
  }
}
