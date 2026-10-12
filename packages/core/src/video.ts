import { z } from 'zod';
import type { BundleFiles } from './bundle';
import type { ShowConfig } from './model';

/**
 * What the transcoder is asked to do for one bundle. Passed to the Fargate
 * task as a JSON environment variable.
 */
export const TranscodeJob = z.object({
  bucket: z.string().min(1),
  /** inbox/<show>/<bundle>/ */
  bundlePrefix: z.string().endsWith('/'),
  /** File name of the video inside the bundle. */
  video: z.string().min(1),
  /** Write audio.mp3 into the bundle (the bundle has no audio of its own). */
  extractAudio: z.boolean(),
  hls: z
    .object({
      /** Bucket key prefix the HLS files are written under, ending in /. */
      prefix: z.string().endsWith('/'),
      ladder: z.array(z.number().int().positive()).min(1),
    })
    .optional(),
  attempt: z.number().int().min(1).default(1),
});
export type TranscodeJob = z.infer<typeof TranscodeJob>;
export type TranscodeJobInput = z.input<typeof TranscodeJob>;

export const Rendition = z.object({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
  bandwidth: z.number().int().positive(),
});

/** The transcoder's report, written to processed.json in the bundle. */
export const ProcessedResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Set when audio was extracted: the file name now in the bundle. */
    audio: z.string().optional(),
    hls: z
      .object({
        /** Bucket key of the master playlist. */
        masterKey: z.string(),
        renditions: z.array(Rendition).min(1),
      })
      .optional(),
    durationSeconds: z.number().nonnegative().optional(),
    finishedAt: z.iso.datetime(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), finishedAt: z.iso.datetime() }),
]);
export type ProcessedResult = z.infer<typeof ProcessedResult>;

/**
 * Whether a bundle needs the transcoder: video with no audio (extract it),
 * or video for a show that streams HLS. Audiogram shows upload audio plus
 * video and need nothing: the video is just stored for YouTube.
 */
export function planProcessing(
  files: BundleFiles,
  show: ShowConfig,
  bucket: string,
  bundlePrefix: string,
  hlsPrefix: string,
): TranscodeJob | undefined {
  if (!files.video) return undefined;
  const extractAudio = !files.audio;
  const hls = show.video.hls ? { prefix: hlsPrefix, ladder: show.video.ladder } : undefined;
  if (!extractAudio && !hls) return undefined;
  return { bucket, bundlePrefix, video: files.video, extractAudio, hls, attempt: 1 };
}
