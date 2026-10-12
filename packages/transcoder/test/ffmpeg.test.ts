import { describe, expect, it } from 'vitest';
import { hlsArgs, parseProbe, planRenditions, selectLadder, videoKbps } from '../src/ffmpeg';

const probe = { width: 1920, height: 1080, fps: 29.97, durationSeconds: 3600, hasAudio: true };

describe('parseProbe', () => {
  it('reads dimensions, frame rate, duration and audio', () => {
    expect(
      parseProbe({
        streams: [
          { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
          { codec_type: 'audio' },
        ],
        format: { duration: '3600.5' },
      }),
    ).toEqual({
      width: 1920,
      height: 1080,
      fps: 30000 / 1001,
      durationSeconds: 3600.5,
      hasAudio: true,
    });
  });
  it('rejects files without video', () => {
    expect(() => parseProbe({ streams: [{ codec_type: 'audio' }] })).toThrow(/No video/);
  });
});

describe('ladder', () => {
  it('never upscales', () => {
    expect(selectLadder([1080, 720, 480], 720)).toEqual([720, 480]);
    expect(selectLadder([1080, 720, 480], 360)).toEqual([360]);
  });
  it('scales bitrate with pixels', () => {
    expect(videoKbps(1080, 30)).toBe(5000);
    expect(videoKbps(720, 30)).toBe(2200);
    expect(videoKbps(1080, 60)).toBe(7500);
  });
  it('keeps aspect ratio with even widths', () => {
    expect(
      planRenditions({ ...probe, width: 1080, height: 1920 }, [1080, 720]).map((r) => [
        r.width,
        r.height,
      ]),
    ).toEqual([
      [608, 1080],
      [406, 720],
    ]);
  });
});

describe('hlsArgs', () => {
  const renditions = planRenditions(probe, [1080, 720, 480]);
  const args = hlsArgs('/in', '/out', probe, renditions);
  const joined = args.join(' ');

  it('writes every rendition in one pass with a master playlist', () => {
    expect(joined).toContain('[0:v]split=3[s0][s1][s2]');
    expect(joined).toContain('-var_stream_map v:0,a:0 v:1,a:1 v:2,a:2');
    expect(joined).toContain('-master_pl_name master.m3u8');
    expect(args.at(-1)).toBe('/out/v%v/index.m3u8');
  });
  it('uses 2-second keyframes and 6-second VOD segments', () => {
    expect(joined).toContain('-g 60 -keyint_min 60 -sc_threshold 0');
    expect(joined).toContain('-hls_time 6 -hls_playlist_type vod');
  });
  it('maps no audio when the source has none', () => {
    const silent = hlsArgs('/in', '/out', { ...probe, hasAudio: false }, renditions).join(' ');
    expect(silent).not.toContain('0:a:0');
    expect(silent).toContain('-var_stream_map v:0 v:1 v:2');
  });
});
