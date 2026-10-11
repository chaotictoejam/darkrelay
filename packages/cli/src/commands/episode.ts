import { EpisodeManifest, episodeId, layout } from '@darkrelay/core';
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
