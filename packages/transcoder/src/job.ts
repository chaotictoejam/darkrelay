import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  MEDIA_CACHE_CONTROL,
  PROCESSED_FILE,
  type ProcessedResult,
  type TranscodeJob,
} from '@darkrelay/core';
import {
  HLS_CONTENT_TYPES,
  audioArgs,
  hlsArgs,
  parseProbe,
  planRenditions,
  probeArgs,
  run,
} from './ffmpeg';

/** Storage operations the job needs; S3 in production, the local disk in tests. */
export interface JobIO {
  download(key: string, path: string): Promise<void>;
  upload(key: string, path: string, contentType: string, cacheControl?: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/**
 * Runs one transcode: probe, extract audio, build HLS, upload, then write
 * processed.json last (its arrival is what resumes publishing). Failures
 * are reported in processed.json too, so the publisher can reject the bundle.
 */
export async function runJob(
  job: TranscodeJob,
  io: JobIO,
  workDir: string,
  now = () => new Date(),
) {
  const processedKey = job.bundlePrefix + PROCESSED_FILE;
  try {
    await mkdir(workDir, { recursive: true });
    const input = join(workDir, 'input');
    console.log(`Downloading ${job.bundlePrefix}${job.video}`);
    await io.download(job.bundlePrefix + job.video, input);
    const probe = parseProbe(JSON.parse(await run('ffprobe', probeArgs(input), true)));
    console.log(
      `Source ${probe.width}x${probe.height} @ ${probe.fps.toFixed(2)} fps, ${probe.durationSeconds.toFixed(0)} s, audio: ${probe.hasAudio}`,
    );

    let audio: string | undefined;
    if (job.extractAudio) {
      if (!probe.hasAudio) throw new Error('The video has no audio track to extract');
      const out = join(workDir, 'audio.mp3');
      await run('ffmpeg', audioArgs(input, out));
      await io.upload(job.bundlePrefix + 'audio.mp3', out, 'audio/mpeg');
      audio = 'audio.mp3';
    }

    let hls: Extract<ProcessedResult, { ok: true }>['hls'];
    if (job.hls) {
      const outDir = join(workDir, 'hls');
      const renditions = planRenditions(probe, job.hls.ladder);
      console.log(
        `HLS renditions: ${renditions.map((r) => `${r.height}p@${r.videoKbps}k`).join(', ')}`,
      );
      await run('ffmpeg', hlsArgs(input, outDir, probe, renditions));
      const files = await filesUnder(outDir);
      await pool(files, 16, async (file) => {
        const ext = file.split('.').pop() ?? '';
        const rel = relative(outDir, file).split('\\').join('/');
        await io.upload(
          job.hls!.prefix + rel,
          file,
          HLS_CONTENT_TYPES[ext] ?? 'application/octet-stream',
          MEDIA_CACHE_CONTROL,
        );
      });
      console.log(`Uploaded ${files.length} HLS files`);
      hls = {
        masterKey: job.hls.prefix + 'master.m3u8',
        renditions: renditions.map(({ height, width, bandwidth }) => ({
          height,
          width,
          bandwidth,
        })),
      };
    }

    const result: ProcessedResult = {
      ok: true,
      audio,
      hls,
      durationSeconds: Math.round(probe.durationSeconds),
      finishedAt: now().toISOString(),
    };
    await io.putJson(processedKey, result);
    return result;
  } catch (e) {
    const result: ProcessedResult = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      finishedAt: now().toISOString(),
    };
    await io.putJson(processedKey, result);
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
