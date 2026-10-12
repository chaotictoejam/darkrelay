import { isUuid } from '../guid';
import { NAMESPACES } from './build';
import { FeedParseError, attr, isNode, list, parseFeedXml, text, type XmlNode } from './parse';

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

const AUDIO_VIDEO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'application/x-mpegURL',
  'application/vnd.apple.mpegurl',
]);

const TRANSCRIPT_TYPES = new Set([
  'text/vtt',
  'application/x-subrip',
  'application/srt',
  'application/json',
  'text/html',
  'text/plain',
]);

const DURATION_RE = /^(\d+|\d{1,2}:\d{2}|\d+:\d{2}:\d{2})(\.\d+)?$/;

/**
 * Checks a feed against what Apple Podcasts, Podcast Index and the
 * Podcasting 2.0 namespace require. Errors block publishing; warnings don't.
 */
export function validateFeed(xml: string): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  let parsed;
  try {
    parsed = parseFeedXml(xml);
  } catch (e) {
    if (e instanceof FeedParseError) {
      err('rss', e.message);
      return { ok: false, errors, warnings };
    }
    throw e;
  }
  const { rss, channel: ch, items } = parsed;

  if (attr(rss, 'version') !== '2.0') err('rss@version', 'must be "2.0"');
  for (const prefix of ['itunes', 'podcast'] as const) {
    if (!usesPrefix(ch, prefix)) continue;
    const declared = attr(rss, `xmlns:${prefix}`);
    if (!declared) err(`rss@xmlns:${prefix}`, `namespace "${prefix}" is used but not declared`);
    else if (declared !== NAMESPACES[prefix])
      err(`rss@xmlns:${prefix}`, `expected ${NAMESPACES[prefix]}, got ${declared}`);
  }

  for (const tag of ['title', 'description', 'link'] as const) {
    if (!text(ch[tag])) err(`channel/${tag}`, 'required');
  }
  if (!text(ch['language'])) err('channel/language', 'required by Apple Podcasts');
  const image = attr(ch['itunes:image'], 'href');
  if (!image) err('channel/itunes:image', 'required (href attribute)');
  else checkUrl(image, 'channel/itunes:image', err, warn, /\.(jpe?g|png)(\?|$)/i);
  if (list(ch['itunes:category']).length === 0)
    err('channel/itunes:category', 'at least one required');
  checkExplicit(ch['itunes:explicit'], 'channel/itunes:explicit', err, true);
  if (!text(ch['itunes:author'])) warn('channel/itunes:author', 'recommended');
  if (!text(isNode(ch['itunes:owner']) ? ch['itunes:owner']['itunes:email'] : undefined))
    warn(
      'channel/itunes:owner',
      'owner email recommended; Podcast Index and Apple use it to verify ownership',
    );

  const showGuid = text(ch['podcast:guid']);
  if (!showGuid) warn('channel/podcast:guid', 'missing; apps will derive one from the feed URL');
  else if (!isUuid(showGuid)) err('channel/podcast:guid', `not a UUID: ${showGuid}`);
  const locked = text(ch['podcast:locked']);
  if (locked !== undefined && locked !== 'yes' && locked !== 'no')
    err('channel/podcast:locked', 'must be "yes" or "no"');
  const self = list(ch['atom:link']).find((l) => attr(l, 'rel') === 'self');
  if (!self) warn('channel/atom:link', 'rel="self" link recommended');

  if (items.length === 0) warn('channel/item', 'feed has no episodes');
  const seen = new Map<string, number>();
  items.forEach((item, i) => validateItem(item, i, seen, err, warn));

  return { ok: errors.length === 0, errors, warnings };
}

function validateItem(
  item: XmlNode,
  i: number,
  seen: Map<string, number>,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
) {
  const p = `item[${i}]`;
  if (!text(item['title'])) err(`${p}/title`, 'required');

  const guid = text(item['guid']);
  if (!guid) err(`${p}/guid`, 'required; apps use it to tell episodes apart');
  else if (seen.has(guid)) err(`${p}/guid`, `duplicate of item[${seen.get(guid)}]: ${guid}`);
  else seen.set(guid, i);

  const pubDate = text(item['pubDate']);
  if (!pubDate) err(`${p}/pubDate`, 'required');
  else if (Number.isNaN(Date.parse(pubDate))) err(`${p}/pubDate`, `not a valid date: ${pubDate}`);

  const enc = item['enclosure'];
  const encUrl = attr(enc, 'url');
  const encType = attr(enc, 'type');
  const encLength = attr(enc, 'length');
  if (!encUrl) err(`${p}/enclosure`, 'required (url attribute)');
  else checkUrl(encUrl, `${p}/enclosure@url`, err, warn);
  if (!encType) err(`${p}/enclosure@type`, 'required');
  else if (!AUDIO_VIDEO_TYPES.has(encType))
    warn(`${p}/enclosure@type`, `unusual media type: ${encType}`);
  if (encLength === undefined) err(`${p}/enclosure@length`, 'required');
  else if (!/^\d+$/.test(encLength)) err(`${p}/enclosure@length`, `not a byte count: ${encLength}`);
  else if (encLength === '0')
    warn(`${p}/enclosure@length`, 'is 0; should be the file size in bytes');

  const duration = text(item['itunes:duration']);
  if (duration === undefined) warn(`${p}/itunes:duration`, 'recommended');
  else if (!DURATION_RE.test(duration)) err(`${p}/itunes:duration`, `invalid format: ${duration}`);
  checkExplicit(item['itunes:explicit'], `${p}/itunes:explicit`, err, false);

  for (const tag of ['itunes:episode', 'itunes:season', 'podcast:episode', 'podcast:season']) {
    const v = text(item[tag]);
    if (v !== undefined && !/^\d+(\.\d+)?$/.test(v)) err(`${p}/${tag}`, `must be a number: ${v}`);
  }

  list(item['podcast:transcript']).forEach((t, j) => {
    const tp = `${p}/podcast:transcript[${j}]`;
    const url = attr(t, 'url');
    const type = attr(t, 'type');
    if (!url) err(tp, 'url attribute required');
    else checkUrl(url, tp, err, warn);
    if (!type) err(tp, 'type attribute required');
    else if (!TRANSCRIPT_TYPES.has(type)) warn(tp, `unusual transcript type: ${type}`);
  });

  list(item['podcast:alternateEnclosure']).forEach((a, j) => {
    const ap = `${p}/podcast:alternateEnclosure[${j}]`;
    if (!attr(a, 'type')) err(ap, 'type attribute required');
    const sources = isNode(a) ? list(a['podcast:source']) : [];
    if (sources.length === 0) err(ap, 'at least one podcast:source required');
    sources.forEach((src) => {
      const uri = attr(src, 'uri');
      if (!uri) err(`${ap}/podcast:source`, 'uri attribute required');
      else checkUrl(uri, `${ap}/podcast:source`, err, warn);
    });
  });

  const chapters = item['podcast:chapters'];
  if (chapters !== undefined) {
    const cp = `${p}/podcast:chapters`;
    const url = attr(chapters, 'url');
    if (!url) err(cp, 'url attribute required');
    else checkUrl(url, cp, err, warn);
    if (attr(chapters, 'type') !== 'application/json+chapters')
      err(cp, 'type must be "application/json+chapters"');
  }
}

function usesPrefix(node: unknown, prefix: string): boolean {
  if (Array.isArray(node)) return node.some((n) => usesPrefix(n, prefix));
  if (!isNode(node)) return false;
  return Object.entries(node).some(([k, v]) => k.startsWith(`${prefix}:`) || usesPrefix(v, prefix));
}

function checkUrl(
  value: string,
  path: string,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
  pattern?: RegExp,
) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    err(path, `not a valid URL: ${value}`);
    return;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') err(path, `unsupported scheme: ${value}`);
  else if (u.protocol === 'http:') warn(path, `not HTTPS: ${value}`);
  if (pattern && !pattern.test(u.pathname)) warn(path, `expected a JPEG or PNG: ${value}`);
}

function checkExplicit(
  v: unknown,
  path: string,
  err: (p: string, m: string) => void,
  required: boolean,
) {
  const value = text(v);
  if (value === undefined) {
    if (required) err(path, 'required ("true" or "false")');
    return;
  }
  // Apple accepts the legacy values; anything else is rejected.
  if (!['true', 'false', 'yes', 'no', 'clean', 'explicit'].includes(value.toLowerCase()))
    err(path, `must be "true" or "false", got "${value}"`);
}
