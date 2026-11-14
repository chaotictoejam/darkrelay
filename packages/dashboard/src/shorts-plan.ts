import { localToIso } from './upload-plan';

/**
 * Turning what someone picked in the browser into a Shorts batch manifest.
 * Kept apart from the form so the rules — which files are clips, what a
 * clip's name becomes in the batch, what the manifest ends up saying — can
 * be read and tested without a DOM.
 */

export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png'];
/** One picker takes both: videos become clips, images become thumbnails. */
export const ACCEPT_BATCH = [...VIDEO_EXT, ...IMAGE_EXT].map((e) => `.${e}`).join(',');

/** YouTube's own limits, checked here so the form can say so before uploading. */
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX_BYTES = 5000;

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

export const isVideo = (name: string) => VIDEO_EXT.includes(ext(name));
export const isImage = (name: string) => IMAGE_EXT.includes(ext(name));

/**
 * The name a picked file gets inside the batch. The API accepts letters,
 * digits, dots, dashes and underscores only, so a name with spaces or
 * accents in it is rewritten rather than refused — the person picked the
 * right file, and what it is called in the inbox is nobody's business.
 */
export function batchName(original: string, taken: Set<string> = new Set()): string {
  const e = ext(original);
  const base = original
    .slice(0, original.length - (e ? e.length + 1 : 0))
    .normalize('NFKD')
    // Accents decompose to combining marks, which would each become a dash.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40);
  const stem = base || 'clip';
  let name = e ? `${stem}.${e}` : stem;
  for (let n = 2; taken.has(name); n++) name = e ? `${stem}-${n}.${e}` : `${stem}-${n}`;
  taken.add(name);
  return name;
}

/** A first guess at a title: the file name, made readable. */
export function titleFromName(original: string): string {
  const e = ext(original);
  const base = original.slice(0, original.length - (e ? e.length + 1 : 0));
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** One clip's row on the form, as text, before any of it is interpreted. */
export interface ClipInput {
  /** Name inside the batch, which is what the manifest points at. */
  name: string;
  title: string;
  description: string;
  /** Comma-separated, as typed. */
  tags: string;
  /** An episode id, or empty for a standalone clip. */
  parentId: string;
  /** Batch name of a picked image, or empty. */
  thumbnail: string;
  /** A `datetime-local` value, or empty to leave the slot to the planner. */
  slot: string;
}

export interface BatchDefaults {
  kind: 'short' | 'video';
  /** Outlet id, or empty for the brand's first channel. */
  outlet: string;
  description: string;
  tags: string;
}

export interface ManifestItem {
  file: string;
  title: string;
  description?: string;
  tags?: string[];
  parentId?: string;
  thumbnail?: string;
  publishAt?: string;
}

export interface ManifestBody {
  kind: 'short' | 'video';
  outlet?: string;
  defaults?: { description?: string; tags?: string[] };
  shorts: ManifestItem[];
}

const tagList = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The manifest for a batch, or every problem with it at once. Empty fields
 * are left out rather than sent empty, so a clip with nothing of its own
 * takes the batch defaults — the same way a hand-written shorts.json does.
 */
export function buildBatch(
  clips: ClipInput[],
  defaults: BatchDefaults,
): { body: ManifestBody; errors: string[] } {
  const errors: string[] = [];
  if (!clips.length) errors.push('Choose at least one video file.');

  const shorts: ManifestItem[] = clips.map((clip, index) => {
    const where = clip.title.trim() || clip.name || `clip ${index + 1}`;
    const title = clip.title.trim();
    if (!title) errors.push(`${clip.name}: add a title.`);
    if (title.length > TITLE_MAX)
      errors.push(`${where}: titles are limited to ${TITLE_MAX} characters.`);
    if (/[<>]/.test(title)) errors.push(`${where}: YouTube does not allow < or > in titles.`);
    const description = clip.description.trim();
    if (/[<>]/.test(description))
      errors.push(`${where}: YouTube does not allow < or > in descriptions.`);
    if (bytes(description) > DESCRIPTION_MAX_BYTES)
      errors.push(`${where}: descriptions are limited to ${DESCRIPTION_MAX_BYTES} bytes.`);

    let publishAt: string | undefined;
    if (clip.slot) {
      publishAt = localToIso(clip.slot);
      if (!publishAt) errors.push(`${where}: that slot is not a real date and time.`);
    }

    const tags = tagList(clip.tags);
    return {
      file: clip.name,
      title,
      ...(description ? { description } : {}),
      ...(tags.length ? { tags } : {}),
      ...(clip.parentId ? { parentId: clip.parentId } : {}),
      ...(clip.thumbnail ? { thumbnail: clip.thumbnail } : {}),
      ...(publishAt ? { publishAt } : {}),
    };
  });

  const batchDescription = defaults.description.trim();
  if (bytes(batchDescription) > DESCRIPTION_MAX_BYTES)
    errors.push(`The shared description is limited to ${DESCRIPTION_MAX_BYTES} bytes.`);
  if (/[<>]/.test(batchDescription)) errors.push('YouTube does not allow < or > in descriptions.');
  const batchTags = tagList(defaults.tags);

  return {
    body: {
      kind: defaults.kind,
      ...(defaults.outlet ? { outlet: defaults.outlet } : {}),
      ...(batchDescription || batchTags.length
        ? {
            defaults: {
              ...(batchDescription ? { description: batchDescription } : {}),
              ...(batchTags.length ? { tags: batchTags } : {}),
            },
          }
        : {}),
      shorts,
    },
    errors,
  };
}
