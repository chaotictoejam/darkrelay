import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  EpisodeManifest,
  ShowConfig,
  contentTypeFor,
  feedUrl,
  layout,
  podcastGuidFromFeedUrl,
  publicKey,
  type ShowConfigInput,
} from '@darkrelay/core';
import { z } from 'zod';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';

export async function loadShow(bucket: Bucket, slug: string): Promise<ShowConfig | undefined> {
  const raw = await bucket.getText(layout.showConfig(slug));
  return raw ? ShowConfig.parse(JSON.parse(raw)) : undefined;
}

export async function loadEpisodes(bucket: Bucket, slug: string): Promise<EpisodeManifest[]> {
  const episodes: EpisodeManifest[] = [];
  for (const key of await bucket.list(layout.episodesPrefix(slug))) {
    if (!key.endsWith('.json')) continue;
    episodes.push(EpisodeManifest.parse(JSON.parse((await bucket.getText(key))!)));
  }
  return episodes;
}

/**
 * Creates or updates a show from a JSON file. A new show gets a podcast:guid
 * derived from its feed URL; an existing show's guid is never changed.
 */
export async function putShow(file: string, flags: { image?: string }, global: GlobalOptions) {
  const input = JSON.parse(await readFile(file, 'utf8')) as Partial<ShowConfigInput>;
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  if (!input.slug) throw new Error('show file needs a "slug"');
  const existing = await loadShow(bucket, input.slug);

  if (existing && input.podcastGuid && input.podcastGuid !== existing.podcastGuid) {
    throw new Error(
      `podcastGuid can't change (${existing.podcastGuid} -> ${input.podcastGuid}); apps would treat it as a new show.`,
    );
  }

  let image = input.image ?? existing?.image;
  if (flags.image) {
    const bytes = await readFile(flags.image);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    const key = `${input.slug}/cover-${hash}${extname(flags.image).toLowerCase()}`;
    await bucket.uploadFile(
      publicKey(key),
      flags.image,
      contentTypeFor(flags.image),
      'public, max-age=86400',
    );
    image = { key };
  }

  const parsed = ShowConfig.safeParse({
    schemaVersion: 1,
    status: 'draft',
    ...existing,
    ...input,
    image,
    podcastGuid:
      existing?.podcastGuid ??
      input.podcastGuid ??
      podcastGuidFromFeedUrl(feedUrl(baseUrl, input.slug)),
  });
  if (!parsed.success) throw new Error(`Invalid show:\n${z.prettifyError(parsed.error)}`);
  await bucket.putText(layout.showConfig(parsed.data.slug), JSON.stringify(parsed.data, null, 2));
  console.log(
    `${existing ? 'Updated' : 'Created'} show ${parsed.data.slug} (${parsed.data.status}).`,
  );
  console.log(`podcast:guid ${parsed.data.podcastGuid}`);
  console.log(
    parsed.data.status === 'live'
      ? `Feed: ${feedUrl(baseUrl, parsed.data.slug)}`
      : `Draft: preview feed at s3://${name}/${layout.previewFeed(parsed.data.slug)}`,
  );
}

export async function setShowStatus(slug: string, status: 'draft' | 'live', global: GlobalOptions) {
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const show = await loadShow(bucket, slug);
  if (!show) throw new Error(`Show "${slug}" does not exist`);
  await bucket.putText(layout.showConfig(slug), JSON.stringify({ ...show, status }, null, 2));
  console.log(`${slug} is now ${status}.`);
  if (status === 'live') console.log(`Feed: ${feedUrl(baseUrl, slug)}`);
}

export async function showStatus(slug: string, global: GlobalOptions) {
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const show = await loadShow(bucket, slug);
  if (!show) throw new Error(`Show "${slug}" does not exist`);
  console.log(`${show.title} (${slug}): ${show.status}`);
  console.log(`podcast:guid ${show.podcastGuid}`);
  console.log(
    show.status === 'live'
      ? `Feed: ${feedUrl(baseUrl, slug)}`
      : `Preview: s3://${name}/${layout.previewFeed(slug)}`,
  );
  const errors = await bucket.getText(layout.feedErrors(slug));
  if (errors) {
    console.log('Last feed build FAILED validation; the previous feed is still being served:');
    console.log(errors);
    process.exitCode = 1;
  }
}

export async function requestRebuild(slug: string, global: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  await bucket.putText(layout.rebuildRequest(slug), '', 'text/plain');
  console.log(`Rebuild requested for ${slug}.`);
}
