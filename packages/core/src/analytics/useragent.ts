import apps from './opawg/apps.json';
import bots from './opawg/bots.json';
import browsers from './opawg/browsers.json';
import devices from './opawg/devices.json';
import libraries from './opawg/libraries.json';

interface Entry {
  name: string;
  pattern: string;
  category?: string;
}
interface Compiled {
  name: string;
  re: RegExp;
  category?: string;
}

export type UaKind = 'bot' | 'app' | 'library' | 'browser' | 'unknown';

export interface UaInfo {
  kind: UaKind;
  name: string;
  device?: string;
  deviceCategory?: string;
  /**
   * A self-hosted server fetched the file for later playback (e.g.
   * audiobookshelf). Counted as a download, not a listen.
   */
  server: boolean;
}

/** OPAWG has no category for these; they download on a schedule, not when someone listens. */
export const SERVER_SIDE_APPS = new Set([
  'audiobookshelf',
  'Pinepods',
  'Podgrab',
  'Podcast Archiver',
]);

function compile(entries: Entry[]): Compiled[] {
  return entries.flatMap((e) => {
    try {
      return [{ name: e.name, re: new RegExp(e.pattern), category: e.category }];
    } catch {
      return []; // A pattern JS can't compile is skipped rather than failing every run.
    }
  });
}

const LISTS = {
  bots: compile(bots),
  apps: compile(apps),
  libraries: compile(libraries),
  browsers: compile(browsers),
  devices: compile(devices),
};

const first = (list: Compiled[], ua: string) => list.find((e) => e.re.test(ua));

/** Classifies a User-Agent the way OPAWG specifies: bots, apps, libraries, browsers, first match wins. */
export function classifyUserAgent(ua: string | undefined): UaInfo {
  const value = (ua ?? '').trim();
  if (!value || value === '-') return { kind: 'bot', name: 'Empty user agent', server: false };

  const device = first(LISTS.devices, value);
  const withDevice = (kind: UaKind, name: string): UaInfo => ({
    kind,
    name,
    device: device?.name,
    deviceCategory: device?.category,
    server: kind === 'app' && SERVER_SIDE_APPS.has(name),
  });

  const bot = first(LISTS.bots, value);
  if (bot) return { kind: 'bot', name: bot.name, server: false };
  const app = first(LISTS.apps, value);
  if (app) return withDevice('app', app.name);
  const lib = first(LISTS.libraries, value);
  if (lib)
    return lib.category === 'bot'
      ? { kind: 'bot', name: lib.name, server: false }
      : withDevice('library', lib.name);
  const browser = first(LISTS.browsers, value);
  if (browser) return withDevice('browser', browser.name);
  return withDevice('unknown', 'Unknown');
}

export function compiledPatternCounts() {
  return Object.fromEntries(Object.entries(LISTS).map(([k, v]) => [k, v.length]));
}
