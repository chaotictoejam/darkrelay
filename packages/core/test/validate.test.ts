import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateFeed } from '../src';

const anchor = readFileSync(new URL('./fixtures/anchor-style.xml', import.meta.url), 'utf8');

const minimal = (items: string, channelExtra = '') => `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>T</title><description>D</description><link>https://e.com</link><language>en</language>
<itunes:image href="https://e.com/c.jpg"/><itunes:category text="Technology"/><itunes:explicit>false</itunes:explicit>
${channelExtra}${items}</channel></rss>`;

const item = (guid: string, extra = '') =>
  `<item><title>x</title><guid>${guid}</guid><pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://e.com/a.mp3" length="10" type="audio/mpeg"/><itunes:duration>60</itunes:duration>${extra}</item>`;

const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

describe('validateFeed', () => {
  it('accepts a Spotify-style feed, warning about the missing podcast:guid', () => {
    const r = validateFeed(anchor);
    expect(r.errors).toEqual([]);
    expect(paths(r.warnings)).toContain('channel/podcast:guid');
  });

  it('rejects malformed XML', () => {
    const r = validateFeed('<rss><channel>');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/Malformed XML/);
  });

  it('rejects duplicate guids', () => {
    const r = validateFeed(minimal(item('a') + item('a')));
    expect(r.errors).toEqual([expect.objectContaining({ path: 'item[1]/guid' })]);
  });

  it('rejects missing enclosure length, bad durations and bad chapters type', () => {
    const r = validateFeed(
      minimal(
        `<item><title>x</title><guid>g</guid><pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://e.com/a.mp3" type="audio/mpeg"/><itunes:duration>1h</itunes:duration><podcast:chapters url="https://e.com/c.json" type="application/json"/></item>`,
      ),
    );
    expect(paths(r.errors)).toEqual([
      'item[0]/enclosure@length',
      'item[0]/itunes:duration',
      'item[0]/podcast:chapters',
    ]);
  });

  it('rejects an undeclared namespace and a non-UUID podcast:guid', () => {
    const xml = minimal(item('a'), '<podcast:guid>nope</podcast:guid>').replace(
      ' xmlns:podcast="https://podcastindex.org/namespace/1.0"',
      '',
    );
    expect(paths(validateFeed(xml).errors)).toEqual(['rss@xmlns:podcast', 'channel/podcast:guid']);
  });

  it('requires channel essentials', () => {
    const r = validateFeed('<rss version="2.0"><channel><title>T</title></channel></rss>');
    expect(paths(r.errors)).toEqual([
      'channel/description',
      'channel/link',
      'channel/language',
      'channel/itunes:image',
      'channel/itunes:category',
      'channel/itunes:explicit',
    ]);
  });

  it('requires a type and a source on alternate enclosures', () => {
    const r = validateFeed(
      minimal(item('a', '<podcast:alternateEnclosure title="Video"></podcast:alternateEnclosure>')),
    );
    expect(paths(r.errors)).toEqual([
      'item[0]/podcast:alternateEnclosure[0]',
      'item[0]/podcast:alternateEnclosure[0]',
    ]);
  });
});
