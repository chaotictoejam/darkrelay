/** What each picker on the upload form is for, and the bundle name its file gets. */
export type Slot = 'media' | 'transcript' | 'chapters' | 'cover' | 'audiogram';

export interface Picked {
  slot: Slot;
  file: { name: string; size: number };
}

export interface PlannedFile {
  slot: Slot;
  /** Name inside the bundle, as `darkrelay publish` would use. */
  name: string;
  size: number;
}

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

const ALLOWED: Record<Slot, string[]> = {
  media: ['mp3', 'm4a', 'mp4'],
  transcript: ['vtt', 'srt', 'json'],
  chapters: ['json'],
  cover: ['jpg', 'jpeg', 'png'],
  audiogram: ['mp4'],
};

export const ACCEPT: Record<Slot, string> = Object.fromEntries(
  Object.entries(ALLOWED).map(([slot, exts]) => [slot, exts.map((e) => `.${e}`).join(',')]),
) as Record<Slot, string>;

/** Bundle file names for the picked files, or every problem at once. */
export function planFiles(picked: Picked[]): { files: PlannedFile[]; errors: string[] } {
  const errors: string[] = [];
  const files: PlannedFile[] = [];
  const media = picked.find((p) => p.slot === 'media');
  if (!media) errors.push('Choose an audio (MP3, M4A) or video (MP4) file.');
  for (const p of picked) {
    const e = ext(p.file.name);
    if (!ALLOWED[p.slot].includes(e)) {
      errors.push(`${p.file.name}: expected ${ACCEPT[p.slot].replaceAll(',', ', ')}`);
      continue;
    }
    if (p.file.size === 0) errors.push(`${p.file.name} is empty`);
    let name: string;
    if (p.slot === 'media') name = e === 'mp4' ? 'video.mp4' : `audio.${e}`;
    else if (p.slot === 'audiogram') name = 'video.mp4';
    else if (p.slot === 'chapters') name = 'chapters.json';
    else name = `${p.slot}.${e}`;
    files.push({ slot: p.slot, name, size: p.file.size });
  }
  if (files.filter((f) => f.name === 'video.mp4').length > 1)
    errors.push('A video episode already has its video; leave out the audiogram.');
  return { files, errors };
}

/**
 * A datetime-local value ("2026-10-20T09:00") read in the browser's time
 * zone, as ISO with that zone's offset. The same rule as `--pub-date`: the
 * time always carries a zone, so nobody gets UTC midnight by accident.
 */
export function localToIso(value: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  // DST gaps move the wall-clock time; report what the date actually is.
  const wall = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
  return `${wall}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** Byte ranges [start, end) of each part, numbered from 1. */
export function partRanges(size: number, partSize: number, partCount: number) {
  return Array.from({ length: partCount }, (_, i) => ({
    partNumber: i + 1,
    start: i * partSize,
    end: Math.min(size, (i + 1) * partSize),
  }));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
