import { describe, expect, it } from 'vitest';
import { bytes, isoToLocal, localToIso, partRanges, planFiles } from '../src/upload-plan';

const f = (name: string, size = 10) => ({ name, size });

describe('planFiles', () => {
  it('names files as darkrelay publish does', () => {
    expect(
      planFiles([
        { slot: 'media', file: f('Episode 12 FINAL.MP3') },
        { slot: 'transcript', file: f('ep12.srt') },
        { slot: 'chapters', file: f('chapters-v2.json') },
        { slot: 'cover', file: f('art.JPEG') },
        { slot: 'audiogram', file: f('gram.mp4') },
      ]),
    ).toEqual({
      errors: [],
      files: [
        { slot: 'media', name: 'audio.mp3', size: 10 },
        { slot: 'transcript', name: 'transcript.srt', size: 10 },
        { slot: 'chapters', name: 'chapters.json', size: 10 },
        { slot: 'cover', name: 'cover.jpeg', size: 10 },
        { slot: 'audiogram', name: 'video.mp4', size: 10 },
      ],
    });
    expect(planFiles([{ slot: 'media', file: f('show.mp4') }]).files[0]!.name).toBe('video.mp4');
  });

  it('reports every problem', () => {
    const { errors } = planFiles([
      { slot: 'transcript', file: f('notes.txt') },
      { slot: 'cover', file: f('art.png', 0) },
    ]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/audio/);
    expect(errors[1]).toMatch(/notes\.txt: expected \.vtt, \.srt, \.json/);
    expect(errors[2]).toMatch(/empty/);
  });

  it('refuses an audiogram on a video episode', () => {
    const { errors } = planFiles([
      { slot: 'media', file: f('ep.mp4') },
      { slot: 'audiogram', file: f('gram.mp4') },
    ]);
    expect(errors).toEqual(['A video episode already has its video; leave out the audiogram.']);
  });
});

describe('planFiles for an update', () => {
  it('allows leaving out the media', () => {
    expect(planFiles([], { update: true })).toEqual({ files: [], errors: [] });
    expect(planFiles([{ slot: 'transcript', file: f('t.vtt') }], { update: true }).errors).toEqual(
      [],
    );
  });

  it('refuses an audiogram without its audio', () => {
    expect(planFiles([{ slot: 'audiogram', file: f('g.mp4') }], { update: true }).errors).toEqual([
      'To replace the audiogram, choose the audio file again too.',
    ]);
  });
});

describe('isoToLocal', () => {
  it('round-trips with localToIso', () => {
    expect(isoToLocal(localToIso('2026-10-20T09:05')!)).toBe('2026-10-20T09:05');
  });
});

describe('localToIso', () => {
  it('keeps the wall-clock time and adds the zone offset', () => {
    const iso = localToIso('2026-10-20T09:00')!;
    expect(iso).toMatch(/^2026-10-20T09:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(iso).getTime()).toBe(new Date(2026, 9, 20, 9, 0).getTime());
  });

  it('refuses dates without a time and impossible dates', () => {
    expect(localToIso('2026-10-20')).toBeUndefined();
    expect(localToIso('2026-02-30T09:00')).toBeUndefined();
    expect(localToIso('')).toBeUndefined();
  });
});

describe('partRanges', () => {
  it('covers the file exactly', () => {
    expect(partRanges(25, 10, 3)).toEqual([
      { partNumber: 1, start: 0, end: 10 },
      { partNumber: 2, start: 10, end: 20 },
      { partNumber: 3, start: 20, end: 25 },
    ]);
    expect(partRanges(0, 10, 1)).toEqual([{ partNumber: 1, start: 0, end: 0 }]);
  });
});

describe('bytes', () => {
  it.each([
    [500, '500 B'],
    [1536, '1.5 KB'],
    [52 * 1024 ** 2, '52 MB'],
    [3.4 * 1024 ** 3, '3.4 GB'],
  ])('%d -> %s', (n, s) => expect(bytes(n)).toBe(s));
});
