import { Readable } from 'node:stream';
import { EpisodeManifest, episodeId, type EpisodeManifestInput } from '@darkrelay/core';
import { describe, expect, it } from 'vitest';
import {
  LengthMismatchError,
  extensionFor,
  migrateEpisode,
  remoteAssets,
  type MigrateDeps,
} from '../src/commands/migrate';

const AUDIO_URL = 'https://anchor.fm/s/abc/podcast/play/1/https%3A%2F%2Fcdn.example.com%2Fep1.mp3';

const manifest = (o: Partial<EpisodeManifestInput> = {}) =>
  EpisodeManifest.parse({
    schemaVersion: 1,
    guid: 'g-1',
    guidIsPermaLink: false,
    title: 'Ep 1',
    description: '',
    pubDate: '2026-10-01T00:00:00Z',
    enclosure: { asset: { url: AUDIO_URL }, length: 5, type: 'audio/mpeg' },
    image: { url: 'https://img.example.com/ep1' },
    transcripts: [{ asset: { url: 'https://cdn.example.com/ep1.vtt' }, type: 'text/vtt' }],
    updatedAt: '2026-10-01T00:00:00Z',
    ...o,
  });

function fakeDeps(files: Record<string, { body: string; finalUrl?: string; type?: string }>) {
  const uploads = new Map<string, { body: string; type: string }>();
  const deps: MigrateDeps = {
    async fetch(url) {
      const f = files[url];
      if (!f) throw new Error(`GET ${url}: HTTP 404`);
      return {
        body: Readable.from([Buffer.from(f.body)]),
        contentType: f.type,
        finalUrl: f.finalUrl ?? url,
      };
    },
    async upload(key, body, type) {
      let s = '';
      for await (const c of body) s += c.toString();
      uploads.set(key, { body: s, type });
    },
    now: () => new Date('2026-10-12T00:00:00Z'),
  };
  return { deps, uploads };
}

const id = episodeId('g-1');

describe('migrateEpisode', () => {
  it('copies every remote file, follows redirects for the file name, and repoints the manifest', async () => {
    const { deps, uploads } = fakeDeps({
      [AUDIO_URL]: { body: '12345', finalUrl: 'https://cdn.example.com/ep1.mp3' },
      'https://img.example.com/ep1': { body: 'img', type: 'image/png' },
      'https://cdn.example.com/ep1.vtt': { body: 'WEBVTT' },
    });
    const { manifest: m, copied } = await migrateEpisode('show', manifest(), deps);

    expect(copied.map((c) => c.key)).toEqual([
      `show/${id}/imported/audio.mp3`,
      `show/${id}/imported/cover.png`,
      `show/${id}/imported/transcript-0.vtt`,
    ]);
    expect(uploads.get(`public/show/${id}/imported/audio.mp3`)).toEqual({
      body: '12345',
      type: 'audio/mpeg',
    });
    expect(m.enclosure).toEqual({
      asset: { key: `show/${id}/imported/audio.mp3` },
      length: 5,
      type: 'audio/mpeg',
    });
    expect(m.image).toEqual({ key: `show/${id}/imported/cover.png` });
    expect(m.transcripts[0]!.asset).toEqual({ key: `show/${id}/imported/transcript-0.vtt` });
    expect(m.migratedFrom).toEqual({
      audio: AUDIO_URL,
      cover: 'https://img.example.com/ep1',
      'transcript-0': 'https://cdn.example.com/ep1.vtt',
    });
    expect(m.guid).toBe('g-1');
    expect(m.updatedAt).toBe('2026-10-12T00:00:00.000Z');
    expect(remoteAssets(m)).toEqual([]);
  });

  it('fails the episode when the audio size does not match the feed', async () => {
    const { deps } = fakeDeps({ [AUDIO_URL]: { body: '123' } });
    await expect(
      migrateEpisode('show', manifest({ image: undefined, transcripts: [] }), deps),
    ).rejects.toThrow(LengthMismatchError);
  });

  it('fills in a missing length from the bytes copied', async () => {
    const { deps } = fakeDeps({ [AUDIO_URL]: { body: '1234567' } });
    const { manifest: m } = await migrateEpisode(
      'show',
      manifest({
        image: undefined,
        transcripts: [],
        enclosure: { asset: { url: AUDIO_URL }, length: 0, type: 'audio/mpeg' },
      }),
      deps,
    );
    expect(m.enclosure.length).toBe(7);
  });

  it('skips files already in the bucket', () => {
    expect(
      remoteAssets(
        manifest({
          enclosure: { asset: { key: 'show/x/imported/audio.mp3' }, length: 5, type: 'audio/mpeg' },
          image: { key: 'show/x/imported/cover.jpg' },
        }),
      ).map((j) => j.role),
    ).toEqual(['transcript-0']);
  });

  it('a failed download leaves the episode untouched', async () => {
    const { deps } = fakeDeps({ [AUDIO_URL]: { body: '12345' } });
    await expect(migrateEpisode('show', manifest(), deps)).rejects.toThrow(/404/);
  });
});

describe('extensionFor', () => {
  it.each([
    ['https://cdn.example.com/a/ep.mp3', undefined, 'mp3'],
    ['https://cdn.example.com/a/ep.JPEG', undefined, 'jpg'],
    ['https://img.example.com/abc', 'image/png; charset=binary', 'png'],
    ['https://img.example.com/abc', 'application/x-thing', 'bin'],
  ])('%s %s -> %s', (url, type, ext) => {
    expect(extensionFor(url, type)).toBe(ext);
  });
});
