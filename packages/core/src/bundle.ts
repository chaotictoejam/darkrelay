import { z } from 'zod';
import { Person, SLUG } from './model';

/**
 * `episode.json` in a DarkRoom bundle. The CLI writes it for you when you
 * publish a bare audio file; DarkRoom can write it directly later.
 */
export const EpisodeInput = z.object({
  schemaVersion: z.literal(1),
  show: z.string().regex(SLUG),
  /** Set once and never changed. The CLI fills it in on first publish. */
  guid: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  link: z.url().optional(),
  /** Defaults to upload time. A future date holds the episode until then. */
  pubDate: z.iso.datetime({ offset: true }).optional(),
  durationSeconds: z.number().int().positive(),
  episodeType: z.enum(['full', 'trailer', 'bonus']).default('full'),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
  explicit: z.boolean().optional(),
  persons: z.array(Person).default([]),
  keywords: z.array(z.string()).default([]),
  transcriptLanguage: z.string().optional(),
});
export type EpisodeInput = z.infer<typeof EpisodeInput>;
export type EpisodeInputRaw = z.input<typeof EpisodeInput>;

export const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
  json: 'application/json',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  xml: 'application/rss+xml; charset=utf-8',
};

export function contentTypeFor(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export interface BundleFiles {
  audio?: string;
  video?: string;
  transcripts: { file: string; type: string }[];
  chapters?: string;
  cover?: string;
}

export interface ClassifyResult {
  files: BundleFiles;
  errors: string[];
  ignored: string[];
}

const TRANSCRIPT_TYPES: Record<string, string> = {
  'transcript.vtt': 'text/vtt',
  'transcript.srt': 'application/x-subrip',
  'transcript.json': 'application/json',
};

/** Sorts bundle file names into roles. `episode.json` is expected and skipped. */
export function classifyBundle(names: string[]): ClassifyResult {
  const files: BundleFiles = { transcripts: [] };
  const errors: string[] = [];
  const ignored: string[] = [];
  const set = (role: 'audio' | 'video' | 'chapters' | 'cover', name: string) => {
    if (files[role]) errors.push(`More than one ${role} file: ${files[role]}, ${name}`);
    else files[role] = name;
  };

  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === 'episode.json') continue;
    if (lower === 'audio.mp3' || lower === 'audio.m4a') set('audio', name);
    else if (lower === 'audio.wav' || lower === 'audio.flac')
      errors.push(
        `${name}: export MP3 (or M4A) for the feed; podcast apps don't play ${lower.split('.')[1]!.toUpperCase()} reliably`,
      );
    else if (lower === 'video.mp4') set('video', name);
    else if (lower === 'chapters.json') set('chapters', name);
    else if (lower === 'cover.jpg' || lower === 'cover.jpeg' || lower === 'cover.png')
      set('cover', name);
    else if (TRANSCRIPT_TYPES[lower])
      files.transcripts.push({ file: name, type: TRANSCRIPT_TYPES[lower] });
    else ignored.push(name);
  }
  if (!files.audio) errors.push('Bundle has no audio.mp3 or audio.m4a');
  return { files, errors, ignored };
}

/** Podcasting 2.0 JSON chapters, the parts apps rely on. */
export const Chapters = z.object({
  version: z.string(),
  chapters: z
    .array(
      z
        .object({
          startTime: z.number().nonnegative(),
          title: z.string().optional(),
          img: z.url().optional(),
          url: z.url().optional(),
          endTime: z.number().nonnegative().optional(),
        })
        .loose(),
    )
    .min(1),
});

export function validateChapters(json: unknown): string[] {
  const r = Chapters.safeParse(json);
  if (!r.success)
    return r.error.issues.map((i) => `chapters.json ${i.path.join('.')}: ${i.message}`);
  const times = r.data.chapters.map((c) => c.startTime);
  for (let i = 1; i < times.length; i++) {
    if (times[i]! < times[i - 1]!) return ['chapters.json: chapters must be in startTime order'];
  }
  return [];
}
