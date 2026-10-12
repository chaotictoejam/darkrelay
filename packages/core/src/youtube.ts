import { z } from 'zod';

/** Limits YouTube enforces on video metadata. */
export const YT_TITLE_MAX = 100;
export const YT_DESCRIPTION_MAX_BYTES = 5000;
export const YT_TAGS_MAX_CHARS = 500;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** YouTube rejects < and > anywhere in titles and descriptions. */
function noAngles(s: string): string {
  return s.replace(/</g, '‹').replace(/>/g, '›');
}

/** Show notes HTML to YouTube's plain text: paragraphs and lists kept, links spelled out. */
export function htmlToText(html: string): string {
  let s = html.replace(/\r/g, '');
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, '').trim();
      return label && decodeEntities(label) !== href ? `${label} (${href})` : href;
    },
  );
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|blockquote)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatTimestamp(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Description timestamps YouTube turns into chapters. YouTube only does so
 * when the first is 0:00, there are at least three, and each is at least
 * 10 seconds long; otherwise this returns nothing.
 */
export function chapterLines(
  chapters: { startTime: number; title?: string }[],
): string | undefined {
  const titled = chapters.filter((c) => c.title?.trim());
  if (titled.length < 3 || titled[0]!.startTime !== 0) return undefined;
  for (let i = 1; i < titled.length; i++) {
    if (titled[i]!.startTime - titled[i - 1]!.startTime < 10) return undefined;
  }
  return titled
    .map((c) => `${formatTimestamp(c.startTime)} ${noAngles(c.title!.trim())}`)
    .join('\n');
}

function truncateBytes(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  const cut = new TextDecoder().decode(bytes.slice(0, max - 3)).replace(/�+$/, '');
  return cut + '...';
}

export interface VideoMetadataInput {
  title: string;
  descriptionHtml: string;
  chapters?: { startTime: number; title?: string }[];
  footer?: string;
  tags: string[];
}

/** Title, description and tags that pass YouTube's validation. */
export function youtubeMetadata(input: VideoMetadataInput) {
  const title = noAngles(decodeEntities(input.title)).trim().slice(0, YT_TITLE_MAX);
  const chapters = input.chapters ? chapterLines(input.chapters) : undefined;
  const parts = [noAngles(htmlToText(input.descriptionHtml))];
  if (chapters) parts.push(`Chapters\n${chapters}`);
  if (input.footer) parts.push(noAngles(input.footer.trim()));
  const description = truncateBytes(parts.filter(Boolean).join('\n\n'), YT_DESCRIPTION_MAX_BYTES);

  const tags: string[] = [];
  let used = 0;
  for (const raw of input.tags) {
    const tag = noAngles(raw.trim()).replace(/,/g, '');
    if (!tag || tags.includes(tag)) continue;
    // YouTube counts quotes around tags with spaces toward the limit.
    const cost = tag.length + (tag.includes(' ') ? 2 : 0) + (tags.length ? 1 : 0);
    if (used + cost > YT_TAGS_MAX_CHARS) break;
    tags.push(tag);
    used += cost;
  }
  return { title, description, tags };
}

/** State of one episode's upload, kept at catalog/<show>/youtube/<episodeId>.json. */
export const UploadState = z.object({
  state: z.enum(['uploading', 'done', 'failed']),
  /** Resumable upload session; valid for about a week. */
  sessionUri: z.string().optional(),
  offset: z.number().int().nonnegative().default(0),
  total: z.number().int().positive().optional(),
  videoKey: z.string().optional(),
  videoId: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type UploadState = z.infer<typeof UploadState>;
