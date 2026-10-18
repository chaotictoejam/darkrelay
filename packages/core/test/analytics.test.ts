import { describe, expect, it } from 'vitest';
import {
  ACCESS_LOG_FIELDS,
  addCounts,
  classifyUserAgent,
  compiledPatternCounts,
  countDownloads,
  emptyCounts,
  minimumBytes,
  parquetColumn,
  parseMediaPath,
  type RequestGroup,
} from '../src';

const APPLE = 'Podcasts/1650.20 CFNetwork/1408.0.4 Darwin/22.5.0';
const SPOTIFY = 'Spotify/8.8.12 Android/33 (SM-G991B)';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const ABS = 'audiobookshelf (+https://audiobookshelf.org)';
const PATH = '/chaotic-commits/676385c932b682b4/imported/audio.m4a';

describe('classifyUserAgent', () => {
  it('compiles every vendored OPAWG pattern', () => {
    expect(compiledPatternCounts()).toEqual({
      bots: 304,
      apps: 561,
      libraries: 59,
      browsers: 11,
      devices: 20,
    });
  });

  it.each([
    [APPLE, 'app', 'Apple Podcasts', 'mobile'],
    [SPOTIFY, 'app', 'Spotify', 'mobile'],
    [BOT, 'bot', 'Googlebot', undefined],
    ['curl/7.81.0', 'bot', 'curl', undefined],
    [
      'AppleCoreMedia/1.0.0.20F66 (iPhone; U; CPU OS 16_5 like Mac OS X; en_us)',
      'library',
      'AppleCoreMedia',
      'mobile',
    ],
    ['', 'bot', 'Empty user agent', undefined],
    ['-', 'bot', 'Empty user agent', undefined],
    ['totally-unknown/1.0', 'unknown', 'Unknown', undefined],
  ])('%s', (ua, kind, name, deviceCategory) => {
    const info = classifyUserAgent(ua);
    expect(info).toMatchObject({ kind, name });
    expect(info.deviceCategory).toBe(deviceCategory);
  });

  it('flags self-hosted aggregators as server downloads', () => {
    expect(classifyUserAgent(ABS)).toMatchObject({ kind: 'app', server: true });
    expect(classifyUserAgent(APPLE).server).toBe(false);
  });
});

describe('parseMediaPath', () => {
  it('maps enclosure audio paths to episodes', () => {
    expect(parseMediaPath(PATH)).toEqual({
      show: 'chaotic-commits',
      episodeId: '676385c932b682b4',
    });
    expect(parseMediaPath('/s/0123456789abcdef/20261011123456-a1b2c3/audio.mp3')).toEqual({
      show: 's',
      episodeId: '0123456789abcdef',
    });
  });

  it.each([
    '/chaotic-commits/feed.xml',
    '/chaotic-commits/676385c932b682b4/imported/cover.jpg',
    '/chaotic-commits/676385c932b682b4/imported/transcript-0.vtt',
    '/chaotic-commits/not-an-id/imported/audio.mp3',
  ])('ignores %s', (p) => expect(parseMediaPath(p)).toBeUndefined());
});

describe('minimumBytes', () => {
  it('is one minute of audio at the file bitrate', () => {
    expect(minimumBytes({ length: 60_000_000, durationSeconds: 3600 })).toBe(1_000_000);
  });
  it('is the whole file when it is under a minute', () => {
    expect(minimumBytes({ length: 500_000, durationSeconds: 30 })).toBe(500_000);
  });
  it('assumes 128 kbps when duration is unknown', () => {
    expect(minimumBytes({})).toBe(960_000);
  });
});

describe('countDownloads', () => {
  const facts = () => ({ length: 60_000_000, durationSeconds: 3600 });
  const g = (o: Partial<RequestGroup>): RequestGroup => ({
    path: PATH,
    userAgent: APPLE,
    country: 'US',
    requests: 1,
    bytes: 60_000_000,
    ...o,
  });

  it('counts one download per listener group and breaks it down', () => {
    const { episodes, filtered } = countDownloads(
      [g({}), g({ userAgent: SPOTIFY, country: 'gb' }), g({ country: undefined })],
      facts,
    );
    expect(filtered).toEqual({ bots: 0, belowMinimum: 0, notAudio: 0 });
    expect(episodes.get('chaotic-commits/676385c932b682b4')).toMatchObject({
      downloads: 3,
      serverDownloads: 0,
      apps: { 'Apple Podcasts': 2, Spotify: 1 },
      countries: { US: 1, GB: 1, Unknown: 1 },
      devices: { mobile: 3 },
    });
  });

  it('drops bots, probes under one minute, and non-audio paths', () => {
    const { episodes, filtered } = countDownloads(
      [
        g({ userAgent: BOT }),
        g({ bytes: 2, requests: 1 }), // Apple's 0-1 byte-range probe
        g({ bytes: 999_999, requests: 3 }),
        g({ path: '/chaotic-commits/feed.xml' }),
      ],
      facts,
    );
    expect(filtered).toEqual({ bots: 1, belowMinimum: 2, notAudio: 1 });
    expect(episodes.size).toBe(0);
  });

  it('sums byte ranges: many small requests from one listener count once they pass a minute', () => {
    const { episodes } = countDownloads([g({ bytes: 1_000_000, requests: 40 })], facts);
    expect(episodes.get('chaotic-commits/676385c932b682b4')!.downloads).toBe(1);
  });

  it('counts self-hosted servers separately, not as listens', () => {
    const { episodes } = countDownloads([g({ userAgent: ABS }), g({})], facts);
    expect(episodes.get('chaotic-commits/676385c932b682b4')).toMatchObject({
      downloads: 1,
      serverDownloads: 1,
      apps: { 'Apple Podcasts': 1 },
    });
  });
});

describe('potential crawlers', () => {
  const facts = () => ({ length: 60_000_000, durationSeconds: 3600 });
  const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const ep = (i: number) => `/chaotic-commits/${String(i).padStart(16, '0')}/imported/audio.mp3`;
  // One network, five IPs, five episodes: the shape of the Oct 2026 crawler.
  const sweep = (asn: string, userAgent = CHROME) =>
    [0, 1, 2, 3, 4].map((i) => ({
      path: ep(i),
      userAgent,
      country: 'JP',
      asn,
      client: `${asn}-${i}`,
      requests: 1,
      bytes: 60_000_000,
    }));
  const tally = (groups: RequestGroup[]) => {
    let downloads = 0;
    let suspect = 0;
    for (const e of countDownloads(groups, facts).episodes.values()) {
      downloads += e.downloads;
      suspect += e.suspectDownloads ?? 0;
    }
    return { downloads, suspect };
  };

  it('keeps the downloads in the total and tallies them as potential crawler', () => {
    expect(tally(sweep('2907'))).toEqual({ downloads: 5, suspect: 5 });
  });

  it('leaves podcast apps alone even when many listeners share a network', () => {
    expect(tally(sweep('7922', APPLE))).toEqual({ downloads: 5, suspect: 0 });
  });

  it('needs several IPs and several episodes on one network', () => {
    const fewIps = sweep('2907').map((g) => ({ ...g, client: 'same' }));
    const fewEpisodes = sweep('2907').map((g) => ({ ...g, path: ep(0) }));
    const noAsn = sweep('-');
    for (const groups of [fewIps, fewEpisodes, noAsn]) expect(tally(groups).suspect).toBe(0);
  });
});

describe('metrics', () => {
  it('adds counts including breakdown maps', () => {
    const a = { ...emptyCounts(), downloads: 2, apps: { X: 2 } };
    const b = { ...emptyCounts(), downloads: 1, serverDownloads: 4, apps: { X: 1, Y: 1 } };
    expect(addCounts(a, { ...b, suspectDownloads: 1 })).toMatchObject({
      downloads: 3,
      serverDownloads: 4,
      suspectDownloads: 1,
      apps: { X: 3, Y: 1 },
    });
  });

  it('maps requested log fields to Parquet column names', () => {
    expect(ACCESS_LOG_FIELDS.map(parquetColumn)).toContain('cs_user_agent');
    expect(parquetColumn('c-ip')).toBe('c_ip');
    expect(parquetColumn('cs(Referer)')).toBe('cs_referer');
  });
});
