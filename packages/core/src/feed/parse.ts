import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** Element names that can repeat; always parsed as arrays. */
const ARRAY_TAGS = new Set([
  'item',
  'itunes:category',
  'podcast:transcript',
  'podcast:person',
  'podcast:alternateEnclosure',
  'podcast:source',
  'atom:link',
  'category',
]);

export type XmlNode = Record<string, unknown>;

export interface ParsedFeed {
  rss: XmlNode;
  channel: XmlNode;
  items: XmlNode[];
}

export class FeedParseError extends Error {}

/**
 * Parses RSS without coercing values: every text node stays a string exactly
 * as written (GUIDs like "007" must not become 7).
 */
export function parseFeedXml(xml: string): ParsedFeed {
  const wellFormed = XMLValidator.validate(xml);
  if (wellFormed !== true) {
    const { msg, line, col } = wellFormed.err;
    throw new FeedParseError(`Malformed XML at ${line}:${col}: ${msg}`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  const doc = parser.parse(xml) as XmlNode;
  const rss = doc['rss'];
  if (!isNode(rss)) throw new FeedParseError('Missing <rss> root element');
  const channel = rss['channel'];
  if (!isNode(channel)) throw new FeedParseError('Missing <channel> element');
  const items = Array.isArray(channel['item']) ? (channel['item'] as XmlNode[]) : [];
  return { rss, channel, items };
}

export function isNode(v: unknown): v is XmlNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Text content of an element, whether it parsed as a string or a node with attributes. */
export function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isNode(v) && typeof v['#text'] === 'string') return v['#text'];
  if (Array.isArray(v)) return text(v[0]);
  return undefined;
}

export function attr(v: unknown, name: string): string | undefined {
  const node = Array.isArray(v) ? v[0] : v;
  if (!isNode(node)) return undefined;
  const a = node[`@_${name}`];
  return typeof a === 'string' ? a : undefined;
}

export function list(v: unknown): unknown[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
