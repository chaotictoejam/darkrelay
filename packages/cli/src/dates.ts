import type { EpisodeManifest } from '@darkrelay/core';

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Release time from the command line. Accepts "now", ISO with a zone
 * ("2026-10-20T09:00Z", "2026-10-20T09:00-04:00"), or a local date and time
 * ("2026-10-20 09:00", in this machine's time zone). A bare date is refused:
 * JavaScript would read it as UTC midnight, which is rarely what anyone means.
 */
export function parsePubDate(input: string, now = new Date()): Date {
  const value = input.trim();
  if (value.toLowerCase() === 'now') return now;
  if (ZONED.test(value)) return new Date(value);
  const m = LOCAL.exec(value);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const date = new Date(y, mo - 1, d, h, mi, s);
    if (date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59 || s > 59) {
      throw new Error(`No such date: ${input}`);
    }
    return date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `Add a time to "${input}", e.g. "${value} 06:00" (local) or "${value}T06:00Z" (UTC).`,
    );
  }
  throw new Error(
    `Can't read release time "${input}". Use "YYYY-MM-DD HH:mm" (local), ISO with a zone, or "now".`,
  );
}

export function describeTime(iso: string | Date): string {
  const d = new Date(iso);
  // dateStyle/timeStyle can't be combined with timeZoneName, so spell the fields out.
  const local = d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `${local} (${d.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
}

export type EpisodeState = 'live' | 'scheduled' | 'hidden';

export function episodeState(e: EpisodeManifest, now = new Date()): EpisodeState {
  if (e.status === 'hidden') return 'hidden';
  return Date.parse(e.pubDate) > now.getTime() ? 'scheduled' : 'live';
}
