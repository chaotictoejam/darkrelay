/** 1,284 / 12.9K / 1.2M */
export function compact(n: number): string {
  if (Math.abs(n) < 1000) return n.toLocaleString('en-US');
  if (Math.abs(n) < 1_000_000) return `${trim(n / 1000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(n: number) {
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
}

export function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Every day from `from` to `to` inclusive, so missing days plot as zero. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function fillDays<T extends { date: string }>(
  rows: T[],
  from: string,
  to: string,
  empty: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return daysBetween(from, to).map((d) => byDate.get(d) ?? empty(d));
}

/** Clean axis maximum and ticks: 0 / 5 / 10, 0 / 1K / 2K. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Top entries of a count map, the rest folded into "Other". */
export function topEntries(map: Record<string, number>, limit = 8): [string, number][] {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit - 1).reduce((n, [, v]) => n + v, 0);
  return [...sorted.slice(0, limit - 1), ['Other', rest]];
}

const COUNTRY =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : undefined;

export function countryName(code: string): string {
  if (code === 'Unknown' || code === 'Other') return code;
  try {
    return COUNTRY?.of(code) ?? code;
  } catch {
    return code;
  }
}

const DEVICES: Record<string, string> = {
  mobile: 'Phone or tablet',
  computer: 'Computer',
  smart_speaker: 'Smart speaker',
  smart_tv: 'Smart TV',
  watch: 'Watch',
  auto: 'Car',
  unknown: 'Unknown',
};

export function deviceName(category: string): string {
  return DEVICES[category] ?? category.replace(/_/g, ' ');
}
