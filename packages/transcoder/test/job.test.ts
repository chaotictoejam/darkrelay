import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProcessedResult, TranscodeJob } from '@darkrelay/core';
import { runJob, type JobIO } from '../src/job';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A bucket on the local disk. */
function localIO(root: string) {
  const uploads: { key: string; contentType: string; cacheControl?: string }[] = [];
  const io: JobIO = {
    download: (key, path) => copyFile(join(root, key), path),
    async upload(key, path, contentType, cacheControl) {
      await mkdir(dirname(join(root, key)), { recursive: true });
      await copyFile(path, join(root, key));
      uploads.push({ key, contentType, cacheControl });
    },
    async putJson(key, value) {
      await mkdir(dirname(join(root, key)), { recursive: true });
      await writeFile(join(root, key), JSON.stringify(value));
    },
  };
  return { io, uploads };
}

const duration = (file: string) =>
  Number(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ]).toString(),
  );

describe.skipIf(!hasFfmpeg)('runJob with real ffmpeg', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'transcoder-'));
    await mkdir(join(root, 'inbox/show/b1'), { recursive: true });
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '8',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(root, 'inbox/show/b1/video.mp4'),
    ]);
  });

  it('extracts audio and builds an HLS ladder without upscaling', async () => {
    const { io, uploads } = localIO(root);
    const job = TranscodeJob.parse({
      bucket: 'local',
      bundlePrefix: 'inbox/show/b1/',
      video: 'video.mp4',
      extractAudio: true,
      hls: { prefix: 'public/show/abc/b1/hls/', ladder: [1080, 720, 480] },
    });
    const result = await runJob(job, io, join(root, 'work'));
    expect(result).toMatchObject({
      ok: true,
      audio: 'audio.mp3',
      durationSeconds: 8,
      hls: {
        masterKey: 'public/show/abc/b1/hls/master.m3u8',
        renditions: [
          { height: 720, width: 1280 },
          { height: 480, width: 854 },
        ],
      },
    });

    expect(duration(join(root, 'inbox/show/b1/audio.mp3'))).toBeCloseTo(8, 0);
    const master = await readFile(join(root, 'public/show/abc/b1/hls/master.m3u8'), 'utf8');
    expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    expect(master).toContain('RESOLUTION=1280x720');
    const v0 = await readFile(join(root, 'public/show/abc/b1/hls/v0/index.m3u8'), 'utf8');
    expect(v0).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(v0).toContain('#EXT-X-ENDLIST');
    expect(v0.match(/seg_\d{5}\.ts/g)!.length).toBeGreaterThanOrEqual(2);

    expect(uploads.find((u) => u.key.endsWith('.ts'))).toMatchObject({
      contentType: 'video/mp2t',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(uploads.find((u) => u.key.endsWith('master.m3u8'))?.contentType).toBe(
      'application/vnd.apple.mpegurl',
    );

    const processed = ProcessedResult.parse(
      JSON.parse(await readFile(join(root, 'inbox/show/b1/processed.json'), 'utf8')),
    );
    expect(processed.ok).toBe(true);
  });

  it('reports failure in processed.json instead of leaving the bundle stuck', async () => {
    const { io } = localIO(root);
    await mkdir(join(root, 'inbox/show/b2'), { recursive: true });
    await writeFile(join(root, 'inbox/show/b2/video.mp4'), 'not a video');
    const result = await runJob(
      TranscodeJob.parse({
        bucket: 'local',
        bundlePrefix: 'inbox/show/b2/',
        video: 'video.mp4',
        extractAudio: true,
      }),
      io,
      join(root, 'work2'),
    );
    expect(result.ok).toBe(false);
    expect(
      JSON.parse(await readFile(join(root, 'inbox/show/b2/processed.json'), 'utf8')),
    ).toMatchObject({ ok: false });
  });
});
