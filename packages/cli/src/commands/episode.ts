import { EpisodeManifest, episodeId, layout, nextRelease } from '@darkrelay/core';
import { describeTime, episodeState, parsePubDate } from '../dates';
import { loadEpisodes } from './show';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';

/** Hides or restores an episode in the feed. Its media stays where it is. */
export async function setEpisodeStatus(
  slug: string,
  guid: string,
  status: 'published' | 'hidden',
  global: GlobalOptions,
) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const key = layout.episodeManifest(slug, episodeId(guid));
  const raw = await bucket.getText(key);
  if (!raw) throw new Error(`No episode with guid "${guid}" in ${slug}`);
  const manifest = EpisodeManifest.parse(JSON.parse(raw));
  await bucket.putText(
    key,
    JSON.stringify({ ...manifest, status, updatedAt: new Date().toISOString() }, null, 2),
  );
  await bucket.putText(layout.rebuildRequest(slug), '', 'text/plain');
  console.log(`${manifest.title}: ${status}. Feed rebuild requested.`);
}

/** Lists episodes newest first, marking what is live, scheduled or hidden. */
export async function listEpisodes(slug: string, global: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const episodes = (await loadEpisodes(bucket, slug)).sort((a, b) =>
    b.pubDate.localeCompare(a.pubDate),
  );
  const now = new Date();
  for (const e of episodes) {
    const state = episodeState(e, now);
    const when = state === 'scheduled' ? describeTime(e.pubDate) : e.pubDate.slice(0, 10);
    console.log(`${state.padEnd(9)} ${when}  ${e.title}  [${e.guid}]`);
  }
  const next = nextRelease(episodes, now);
  console.log(
    `\n${episodes.length} episodes.` +
      (next ? ` Next release: ${describeTime(next)}.` : ' Nothing scheduled.'),
  );
}

/**
 * Moves an episode's release time. Pulling an already-released episode back
 * into the future removes it from the feed, so that needs --force.
 */
export async function rescheduleEpisode(
  slug: string,
  guid: string,
  flags: { pubDate: string; force?: boolean },
  global: GlobalOptions,
) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const key = layout.episodeManifest(slug, episodeId(guid));
  const raw = await bucket.getText(key);
  if (!raw) throw new Error(`No episode with guid "${guid}" in ${slug}`);
  const manifest = EpisodeManifest.parse(JSON.parse(raw));
  const now = new Date();
  const when = parsePubDate(flags.pubDate, now);
  if (episodeState(manifest, now) === 'live' && when > now && !flags.force) {
    throw new Error(
      `"${manifest.title}" is already out. Moving it to the future removes it from the feed until then; pass --force if that is what you want.`,
    );
  }
  await bucket.putText(
    key,
    JSON.stringify(
      { ...manifest, pubDate: when.toISOString(), updatedAt: now.toISOString() },
      null,
      2,
    ),
  );
  await bucket.putText(layout.rebuildRequest(slug), '', 'text/plain');
  console.log(
    when > now
      ? `"${manifest.title}" now releases ${describeTime(when)}.`
      : `"${manifest.title}" released (dated ${describeTime(when)}). Feed rebuild requested.`,
  );
}
