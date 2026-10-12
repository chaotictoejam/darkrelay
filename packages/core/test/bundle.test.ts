import { describe, expect, it } from 'vitest';
import { classifyBundle, validateChapters } from '../src';

describe('classifyBundle', () => {
  it('sorts files into roles', () => {
    const r = classifyBundle([
      'episode.json',
      'audio.mp3',
      'transcript.vtt',
      'transcript.srt',
      'chapters.json',
      'cover.jpg',
      'video.mp4',
      'notes.txt',
    ]);
    expect(r.errors).toEqual([]);
    expect(r.files).toEqual({
      audio: 'audio.mp3',
      video: 'video.mp4',
      chapters: 'chapters.json',
      cover: 'cover.jpg',
      transcripts: [
        { file: 'transcript.vtt', type: 'text/vtt' },
        { file: 'transcript.srt', type: 'application/x-subrip' },
      ],
    });
    expect(r.ignored).toEqual(['notes.txt']);
  });

  it('requires audio and rejects WAV with a reason', () => {
    const r = classifyBundle(['episode.json', 'audio.wav']);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/export MP3/);
  });

  it('accepts a video-only bundle (audio is extracted) and skips processed.json', () => {
    expect(classifyBundle(['episode.json', 'video.mp4', 'processed.json'])).toEqual({
      files: { video: 'video.mp4', transcripts: [] },
      errors: [],
      ignored: [],
    });
  });

  it('rejects two audio files', () => {
    expect(classifyBundle(['audio.mp3', 'audio.m4a']).errors[0]).toMatch(/More than one audio/);
  });
});

describe('validateChapters', () => {
  it('accepts Podcasting 2.0 chapters', () => {
    expect(
      validateChapters({
        version: '1.2.0',
        chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 60 }],
      }),
    ).toEqual([]);
  });

  it('rejects missing chapters and out-of-order times', () => {
    expect(validateChapters({ version: '1.2.0', chapters: [] })).toHaveLength(1);
    expect(
      validateChapters({ version: '1.2.0', chapters: [{ startTime: 60 }, { startTime: 0 }] }),
    ).toEqual(['chapters.json: chapters must be in startTime order']);
  });
});
