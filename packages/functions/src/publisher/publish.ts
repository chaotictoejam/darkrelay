import {
  EpisodeInput,
  EpisodeManifest,
  classifyBundle,
  contentTypeFor,
  episodeId,
  layout,
  MEDIA_CACHE_CONTROL,
  newEpisodeGuid,
  publicKey,
  validateChapters,
  type EpisodeManifestInput,
} from '@darkrelay/core';
import { loadShow, rebuildFeed, type PublisherDeps, type RebuildResult } from './feed';

export type BundleStatus =
  | {
      status: 'published';
      guid: string;
      episodeId: string;
      feed: RebuildResult['status'];
      feedErrors?: unknown;
      ignoredFiles: string[];
    }
  | { status: 'rejected'; errors: string[] };

/**
 * Publishes an uploaded bundle: validates it, copies its files to versioned
 * public keys, writes the episode manifest and rebuilds the feed. The result
 * is written to the bundle's status key for the CLI to read.
 */
export async function publishBundle(
  deps: PublisherDeps,
  slug: string,
  bundleId: string,
): Promise<BundleStatus> {
  const result = await tryPublish(deps, slug, bundleId);
  await deps.store.put(
    layout.inboxStatus(slug, bundleId),
    JSON.stringify({ ...result, at: deps.now().toISOString() }, null, 2),
    { contentType: 'application/json' },
  );
  deps.log('Bundle processed', { slug, bundleId, ...result });
  return result;
}

async function tryPublish(
  deps: PublisherDeps,
  slug: string,
  bundleId: string,
): Promise<BundleStatus> {
  const { store } = deps;
  const prefix = layout.inboxPrefix(slug, bundleId);
  const objects = await store.list(prefix);
  const names = objects.map((o) => o.key.slice(prefix.length)).filter((n) => !n.includes('/'));
  const errors: string[] = [];

  const show = await loadShow(store, slug);
  if (!show) return { status: 'rejected', errors: [`Show "${slug}" does not exist`] };

  const raw = await store.getText(prefix + 'episode.json');
  let json: unknown;
  try {
    json = JSON.parse(raw ?? '');
  } catch {
    return { status: 'rejected', errors: ['episode.json is missing or not valid JSON'] };
  }
  const parsed = EpisodeInput.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'rejected',
      errors: parsed.error.issues.map((i) => `episode.json ${i.path.join('.')}: ${i.message}`),
    };
  }
  const input = parsed.data;
  if (input.show !== slug)
    errors.push(`episode.json is for show "${input.show}", uploaded to "${slug}"`);

  const { files, errors: fileErrors, ignored } = classifyBundle(names);
  errors.push(...fileErrors);
  if (files.chapters) {
    const chapters = await store.getText(prefix + files.chapters);
    try {
      errors.push(...validateChapters(JSON.parse(chapters ?? '')));
    } catch {
      errors.push('chapters.json is not valid JSON');
    }
  }
  if (errors.length > 0) return { status: 'rejected', errors };

  const guid = input.guid ?? newEpisodeGuid();
  const id = episodeId(guid);
  const previousRaw = await store.getText(layout.episodeManifest(slug, id));
  const previous = previousRaw ? EpisodeManifest.parse(JSON.parse(previousRaw)) : undefined;

  const copyTo = async (name: string) => {
    const key = layout.episodeAsset(slug, id, bundleId, name.toLowerCase());
    await store.copy(prefix + name, publicKey(key), {
      contentType: contentTypeFor(name),
      cacheControl: MEDIA_CACHE_CONTROL,
    });
    return { key };
  };

  const audio = files.audio!;
  const audioSize = objects.find((o) => o.key === prefix + audio)!.size;
  const manifestInput: EpisodeManifestInput = {
    schemaVersion: 1,
    guid,
    guidIsPermaLink: previous ? previous.guidIsPermaLink : false,
    status: previous?.status ?? 'published',
    title: input.title,
    description: input.description,
    link: input.link,
    pubDate: input.pubDate ?? previous?.pubDate ?? deps.now().toISOString(),
    durationSeconds: input.durationSeconds,
    episodeType: input.episodeType,
    season: input.season,
    episode: input.episode,
    explicit: input.explicit,
    image: files.cover ? await copyTo(files.cover) : previous?.image,
    enclosure: { asset: await copyTo(audio), length: audioSize, type: contentTypeFor(audio) },
    transcripts: await Promise.all(
      files.transcripts.map(async (t) => ({
        asset: await copyTo(t.file),
        type: t.type,
        language: input.transcriptLanguage ?? show.language,
      })),
    ),
    chapters: files.chapters ? await copyTo(files.chapters) : undefined,
    persons: input.persons,
    keywords: input.keywords,
    video: files.video ? await copyTo(files.video) : previous?.video,
    updatedAt: deps.now().toISOString(),
  };
  const manifest = EpisodeManifest.parse(manifestInput);
  await store.put(layout.episodeManifest(slug, id), JSON.stringify(manifest, null, 2), {
    contentType: 'application/json',
  });
  await store.delete(objects.map((o) => o.key));

  const feed = await rebuildFeed(deps, slug);
  return {
    status: 'published',
    guid,
    episodeId: id,
    feed: feed.status,
    feedErrors: feed.status === 'invalid' ? feed.errors : undefined,
    ignoredFiles: ignored,
  };
}
