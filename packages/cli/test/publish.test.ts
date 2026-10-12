import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { newBundleId, planBundle } from '../src/commands/publish';

let dir: string;
const duration = async () => 1799.6;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'darkrelay-'));
});

describe('planBundle', () => {
  it('builds a bundle from a bare MP3 and flags', async () => {
    const audio = join(dir, 'Episode 12 final.mp3');
    const vtt = join(dir, 'ep12.vtt');
    await writeFile(audio, 'x');
    await writeFile(vtt, 'WEBVTT');
    const plan = await planBundle(
      audio,
      {
        show: 'chaotic-commits',
        title: 'Ep 12',
        description: '<p>Notes</p>',
        transcript: vtt,
        season: '2',
        episode: '12',
      },
      duration,
    );
    expect(plan.files).toEqual([
      { name: 'audio.mp3', path: audio },
      { name: 'transcript.vtt', path: vtt },
    ]);
    expect(plan.input).toMatchObject({
      show: 'chaotic-commits',
      title: 'Ep 12',
      durationSeconds: 1800,
      season: 2,
      episode: 12,
      episodeType: 'full',
    });
    expect(plan.input.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.sidecar).toBe(`${audio}.episode.json`);
  });

  it('takes a bare video: audio gets extracted on Fargate', async () => {
    const video = join(dir, 'HCU 04.mp4');
    await writeFile(video, 'v');
    const plan = await planBundle(
      video,
      { show: 'her-career-unplugged', title: 'Ep 4', description: 'd' },
      duration,
    );
    expect(plan.files).toEqual([{ name: 'video.mp4', path: video }]);
    expect(plan.input.durationSeconds).toBe(1800);
  });

  it('takes an audiogram alongside the audio', async () => {
    const audio = join(dir, 'ep.mp3');
    const gram = join(dir, 'audiogram.mp4');
    await writeFile(audio, 'a');
    await writeFile(gram, 'v');
    const plan = await planBundle(
      audio,
      { show: 'cc', title: 'T', description: 'd', video: gram },
      duration,
    );
    expect(plan.files.map((f) => f.name)).toEqual(['audio.mp3', 'video.mp4']);
  });

  it('reuses the guid from a saved sidecar so re-publishing updates the episode', async () => {
    const audio = join(dir, 'ep.mp3');
    await writeFile(audio, 'x');
    await writeFile(
      `${audio}.episode.json`,
      JSON.stringify({ guid: 'kept-guid', title: 'Old', description: 'd', durationSeconds: 10 }),
    );
    const plan = await planBundle(audio, { show: 's', title: 'New' }, duration);
    expect(plan.input).toMatchObject({ guid: 'kept-guid', title: 'New', durationSeconds: 10 });
  });

  it('reads a bundle directory with episode.json', async () => {
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'b', 'audio.m4a'), 'x');
    await writeFile(join(dir, 'b', 'chapters.json'), '{}');
    await writeFile(join(dir, 'b', 'notes.txt'), 'ignored');
    await writeFile(
      join(dir, 'b', 'episode.json'),
      JSON.stringify({
        schemaVersion: 1,
        show: 's',
        guid: 'g',
        title: 'T',
        description: 'D',
        durationSeconds: 5,
      }),
    );
    const plan = await planBundle(join(dir, 'b'), { show: 's' }, duration);
    expect(plan.files.map((f) => f.name).sort()).toEqual(['audio.m4a', 'chapters.json']);
    expect(plan.input.guid).toBe('g');
  });

  it('refuses WAV and reports missing details together', async () => {
    const wav = join(dir, 'ep.wav');
    await writeFile(wav, 'x');
    await expect(planBundle(wav, { show: 's' }, duration)).rejects.toThrow(/export MP3/);

    const mp3 = join(dir, 'ep.mp3');
    await writeFile(mp3, 'x');
    await expect(planBundle(mp3, { show: 's' }, async () => undefined)).rejects.toThrow(
      /title[\s\S]*description[\s\S]*durationSeconds/,
    );
  });
});

describe('newBundleId', () => {
  it('is sortable by time and path-safe', () => {
    expect(newBundleId(new Date('2026-10-11T12:34:56Z'))).toMatch(/^20261011123456-[0-9a-f]{6}$/);
  });
});

describe('analytics dates', async () => {
  const { datesFor } = await import('../src/commands/analytics');
  const now = new Date('2026-10-12T05:00:00Z');
  it('defaults to yesterday', () => expect(datesFor({}, now)).toEqual(['2026-10-11']));
  it('expands a range up to yesterday', () =>
    expect(datesFor({ from: '2026-10-09' }, now)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]));
  it('rejects bad dates', () => expect(() => datesFor({ date: ['10/11/2026'] }, now)).toThrow());
});
