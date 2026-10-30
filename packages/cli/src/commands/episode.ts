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

/**
 * Turns episode artwork into the YouTube thumbnail only, for episodes whose
 * artwork was made for YouTube: podcast apps then show the show artwork.
 * YouTube already has the image, so nothing is sent to it.
 */
export async function coverToThumbnail(
  slug: string,
  guid: string | undefined,
  flags: { dryRun?: boolean },
  global: GlobalOptions,
) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const episodes = (await loadEpisodes(bucket, slug)).filter((e) => !guid || e.guid === guid);
  if (guid && !episodes.length) throw new Error(`No episode with guid "${guid}" in ${slug}`);
  let moved = 0;
  for (const manifest of episodes) {
    if (!manifest.image || manifest.thumbnail) continue;
    const image = manifest.image;
    moved++;
    console.log(`${manifest.title}: artwork becomes the YouTube thumbnail.`);
    if (flags.dryRun) continue;
    const updated: EpisodeManifest = {
      ...manifest,
      image: undefined,
      thumbnail: image,
      // Already the video's thumbnail; recorded so it isn't sent again.
      youtube: manifest.youtube && {
        ...manifest.youtube,
        thumbnailKey: manifest.youtube.thumbnailKey ?? ('key' in image ? image.key : undefined),
      },
      updatedAt: new Date().toISOString(),
    };
    await bucket.putText(
      layout.episodeManifest(slug, episodeId(manifest.guid)),
      JSON.stringify(updated, null, 2),
    );
  }
  if (!moved) return console.log('Nothing to change.');
  if (flags.dryRun) return console.log(`${moved} episodes would change (dry run).`);
  await bucket.putText(layout.rebuildRequest(slug), '', 'text/plain');
  console.log(`${moved} episodes changed. Feed rebuild requested.`);
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
