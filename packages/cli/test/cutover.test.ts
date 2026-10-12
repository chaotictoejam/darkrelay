import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { importFeed } from '@darkrelay/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRedirect, preflight } from '../src/commands/cutover';

const source = readFileSync(
  new URL('../../core/test/fixtures/anchor-style.xml', import.meta.url),
  'utf8',
);
const BASE = 'https://media.example.com';
const NOW = new Date('2026-10-12T00:00:00Z');
const imported = () =>
  importFeed(source, { sourceUrl: 'https://anchor.fm/s/abc123/podcast/rss', slug: 'example' });

const migrated = () => {
  const { show, episodes } = imported();
  return {
    show: { ...show, image: { key: 'example/cover.jpg' } },
    episodes: episodes.map((e) => ({
      ...e,
      image: undefined,
      enclosure: { ...e.enclosure, asset: { key: `example/${e.guid.length}/imported/audio.mp3` } },
    })),
  };
};

describe('preflight', () => {
  it('blocks while media is still on the old host', () => {
    const { show, episodes } = imported();
    const r = preflight(show, episodes, BASE, source, { now: NOW });
    expect(r.problems.join('\n')).toMatch(/3 episode\(s\) still have files/);
    expect(r.problems.join('\n')).toMatch(/Show artwork/);
  });

  it('passes once media is migrated and every old guid is present', () => {
    const { show, episodes } = migrated();
    expect(preflight(show, episodes, BASE, source, { now: NOW })).toEqual({
      problems: [],
      notes: [],
    });
  });

  it('can go live with remote media when allowed', () => {
    const { show, episodes } = imported();
    expect(
      preflight(show, episodes, BASE, source, { now: NOW, allowRemoteMedia: true }).problems,
    ).toEqual([]);
  });

  it('blocks when an old episode would disappear', () => {
    const { show, episodes } = migrated();
    const r = preflight(show, episodes.slice(1), BASE, source, { now: NOW });
    expect(r.problems).toEqual([
      expect.stringContaining('1 episode(s) in the old feed are missing'),
    ]);
  });

  it('blocks a locked source feed and a changed podcast:guid', () => {
    const { show, episodes } = migrated();
    const locked = { ...show, source: { ...show.source!, locked: true } };
    const withGuid = source.replace(
      '<itunes:type>',
      '<podcast:guid>11111111-2222-5333-8444-555555555555</podcast:guid><itunes:type>',
    );
    const problems = preflight(locked, episodes, BASE, withGuid, { now: NOW }).problems.join('\n');
    expect(problems).toMatch(/podcast:locked/);
    expect(problems).toMatch(/podcast:guid differs/);
  });

  it('notes episodes that exist only on DarkRelay', () => {
    const { show, episodes } = migrated();
    const extra = { ...episodes[0]!, guid: 'new-on-darkrelay' };
    expect(preflight(show, [...episodes, extra], BASE, source, { now: NOW }).notes).toEqual([
      '1 episode(s) are only in the new feed (published on DarkRelay).',
    ]);
  });
});

describe('checkRedirect', () => {
  let server: Server;
  let base: string;
  const NEW = 'https://media.example.com/example/feed.xml';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(301, { Location: NEW }).end();
      } else if (req.url === '/tagged') {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(
          source.replace(
            '<itunes:type>',
            `<itunes:new-feed-url>${NEW}</itunes:new-feed-url><itunes:type>`,
          ),
        );
      } else {
        res.writeHead(200).end(source);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('accepts a 301 to the new feed', async () => {
    expect(await checkRedirect(`${base}/moved`, NEW)).toMatchObject({ status: 301, done: true });
  });
  it('accepts itunes:new-feed-url on the old feed', async () => {
    expect(await checkRedirect(`${base}/tagged`, NEW)).toMatchObject({
      newFeedUrl: NEW,
      done: true,
    });
  });
  it('reports a feed that is not redirecting yet', async () => {
    expect(await checkRedirect(`${base}/old`, NEW)).toMatchObject({ status: 200, done: false });
  });
});
