import { describe, expect, it } from 'vitest';
import { planProcessing } from '../src';
import { show } from './helpers';

const args = ['media', 'inbox/s/b1/', 'public/s/id/b1/hls/'] as const;

describe('planProcessing', () => {
  it('does nothing for audio-only bundles', () => {
    expect(
      planProcessing({ audio: 'audio.mp3', transcripts: [] }, show(), ...args),
    ).toBeUndefined();
  });

  it('keeps an audiogram as-is when the show does not stream video', () => {
    expect(
      planProcessing({ audio: 'audio.mp3', video: 'video.mp4', transcripts: [] }, show(), ...args),
    ).toBeUndefined();
  });

  it('extracts audio from a video-only bundle', () => {
    expect(planProcessing({ video: 'video.mp4', transcripts: [] }, show(), ...args)).toMatchObject({
      extractAudio: true,
      hls: undefined,
    });
  });

  it('builds HLS for video shows, keeping uploaded audio', () => {
    const videoShow = show({ video: { hls: true, ladder: [720, 480] } });
    expect(
      planProcessing(
        { audio: 'audio.mp3', video: 'video.mp4', transcripts: [] },
        videoShow,
        ...args,
      ),
    ).toEqual({
      bucket: 'media',
      bundlePrefix: 'inbox/s/b1/',
      video: 'video.mp4',
      extractAudio: false,
      hls: { prefix: 'public/s/id/b1/hls/', ladder: [720, 480] },
      attempt: 1,
    });
  });
});
