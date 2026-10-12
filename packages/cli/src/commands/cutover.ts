import {
  buildFeed,
  feedUrl,
  layout,
  parseFeedXml,
  text,
  validateFeed,
  type EpisodeManifest,
  type ShowConfig,
} from '@darkrelay/core';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { remoteAssets } from './migrate';
import { loadEpisodes, loadShow } from './show';
import { formatResult, readFeedSource } from './validate';

export interface Preflight {
  problems: string[];
  notes: string[];
}

export function feedGuids(xml: string): string[] {
  return parseFeedXml(xml)
    .items.map((i) => text(i['guid']))
    .filter((g): g is string => g !== undefined);
}

/**
 * Everything that must hold before the public feed replaces the old one.
 * Pure, so it can run against a local build of the feed.
 */
export function preflight(
  show: ShowConfig,
  episodes: EpisodeManifest[],
  baseUrl: string,
  sourceXml: string | undefined,
  opts: { allowRemoteMedia?: boolean; now?: Date } = {},
): Preflight {
  const problems: string[] = [];
  const notes: string[] = [];

  const remote = episodes.filter((e) => remoteAssets(e).length > 0);
  if (remote.length && !opts.allowRemoteMedia) {
    problems.push(
      `${remote.length} episode(s) still have files on the old host. Run migrate-media first, or pass --allow-remote-media.`,
    );
  }
  if ('url' in show.image && !opts.allowRemoteMedia) {
    problems.push('Show artwork is still on the old host. Run migrate-media first.');
  }
  if (show.source?.locked) {
    problems.push(
      'The old feed is <podcast:locked>yes</podcast:locked>. Unlock it at the old host, then re-import or edit source.locked.',
    );
  }

  const xml = buildFeed({ show, episodes, baseUrl, now: opts.now });
  const result = validateFeed(xml);
  if (!result.ok) problems.push(`The new feed fails validation:\n${formatResult(result)}`);

  if (sourceXml) {
    const ours = new Set(feedGuids(xml));
    const theirs = feedGuids(sourceXml);
    const missing = theirs.filter((g) => !ours.has(g));
    if (missing.length) {
      problems.push(
        `${missing.length} episode(s) in the old feed are missing from the new one (apps would drop them): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`,
      );
    }
    const extra = ours.size - (theirs.length - missing.length);
    if (extra > 0)
      notes.push(`${extra} episode(s) are only in the new feed (published on DarkRelay).`);
    const sourceGuid = text(parseFeedXml(sourceXml).channel['podcast:guid']);
    if (sourceGuid && sourceGuid !== show.podcastGuid) {
      problems.push(`podcast:guid differs: old feed ${sourceGuid}, new feed ${show.podcastGuid}.`);
    }
  } else if (show.source) {
    notes.push('Could not fetch the old feed, so episode GUIDs were not compared.');
  }
  if (show.status === 'live') notes.push('Show is already live.');
  return { problems, notes };
}

export interface RedirectCheck {
  status: number;
  location?: string;
  newFeedUrl?: string;
  done: boolean;
}

/** Whether the old feed now sends apps to the new one (301 or itunes:new-feed-url). */
export async function checkRedirect(oldUrl: string, newUrl: string): Promise<RedirectCheck> {
  const res = await fetch(oldUrl, { redirect: 'manual' });
  const location = res.headers.get('location') ?? undefined;
  let newFeedUrl: string | undefined;
  if (res.status === 200) {
    newFeedUrl = text(parseFeedXml(await res.text()).channel['itunes:new-feed-url']);
  }
  const done =
    ((res.status === 301 || res.status === 308) && location === newUrl) || newFeedUrl === newUrl;
  return { status: res.status, location, newFeedUrl, done };
}

export interface CutoverFlags {
  go?: boolean;
  ping?: boolean;
  allowRemoteMedia?: boolean;
  checkRedirect?: boolean;
}

/**
 * Step 3 of a migration. Without --go it only runs the preflight checks.
 * With --go it makes the show live, waits for the public feed and verifies it.
 */
export async function cutover(slug: string, flags: CutoverFlags, global: GlobalOptions) {
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const show = await loadShow(bucket, slug);
  if (!show) throw new Error(`Show "${slug}" does not exist`);
  const newUrl = feedUrl(baseUrl, slug);

  if (flags.checkRedirect) {
    if (!show.source)
      throw new Error(`${slug} was not imported, so there is no old feed to check.`);
    const r = await checkRedirect(show.source.feedUrl, newUrl);
    console.log(`Old feed ${show.source.feedUrl}: HTTP ${r.status}`);
    if (r.location) console.log(`  Location: ${r.location}`);
    if (r.newFeedUrl) console.log(`  itunes:new-feed-url: ${r.newFeedUrl}`);
    console.log(r.done ? 'Redirect is in place.' : `Not redirecting to ${newUrl} yet.`);
    if (!r.done) process.exitCode = 1;
    return;
  }

  const episodes = await loadEpisodes(bucket, slug);
  const sourceXml = show.source
    ? await readFeedSource(show.source.feedUrl).catch(() => undefined)
    : undefined;
  const { problems, notes } = preflight(show, episodes, baseUrl, sourceXml, flags);
  for (const n of notes) console.log(`note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`problem: ${p}`);
    console.log('Preflight FAILED. Nothing changed.');
    process.exitCode = 1;
    return;
  }
  console.log(`Preflight passed: ${episodes.length} episodes, podcast:guid ${show.podcastGuid}.`);
  if (!flags.go) {
    console.log(`Run again with --go to publish ${newUrl}`);
    return;
  }

  const ping = flags.ping !== false;
  await bucket.putText(
    layout.showConfig(slug),
    JSON.stringify({ ...show, status: 'live', podcastIndexNotify: ping }, null, 2),
  );
  console.log(`${slug} is live. Waiting for ${newUrl} ...`);
  const live = await waitForFeed(newUrl, episodes.length);
  if (!live) {
    console.log('The public feed did not appear within 2 minutes. Check: darkrelay status ' + slug);
    process.exitCode = 1;
    return;
  }
  console.log(formatResult(validateFeed(live)));
  if (ping) console.log('Podcast Index was notified.');

  console.log(`
Next, at the old host:
  1. Set the feed to redirect (301) to ${newUrl}. In Spotify for Creators this is the
     option to redirect or move your podcast; other hosts call it "redirect feed".
  2. Keep the old account until apps have moved (Apple suggests at least 4 weeks).
  3. Check the redirect with: darkrelay cutover ${slug} --check-redirect
Apple Podcasts, Spotify and Podcast Index follow the redirect; no resubmission needed.`);
}

async function waitForFeed(url: string, minItems: number, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(url).catch(() => undefined);
    if (res?.ok) {
      const xml = await res.text();
      if (feedGuids(xml).length >= minItems) return xml;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return undefined;
}
