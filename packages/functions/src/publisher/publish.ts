import {
  EpisodeInput,
  EpisodeManifest,
  classifyBundle,
  contentTypeFor,
  episodeId,
  layout,
  MEDIA_CACHE_CONTROL,
  DARKRELAY_NAMESPACE,
  NO_MEDIA_ERROR,
  PROCESSED_FILE,
  PUBLIC_PREFIX,
  ProcessedResult,
  planProcessing,
  uuidV5,
  publicKey,
  validateChapters,
  type EpisodeManifestInput,
  type TranscodeJob,
} from '@darkrelay/core';
import { loadShow, rebuildFeed, type PublisherDeps, type RebuildResult } from './feed';

export type BundleStatus =
  | {
      status: 'published';
      guid: string;
      episodeId: string;
      feed: RebuildResult['status'];
      feedErrors?: unknown;
      /** Set when pubDate is in the future: the episode is held until then. */
      scheduledFor?: string;
      ignoredFiles: string[];
    }
  | { status: 'processing'; guid: string; episodeId: string; job: TranscodeJob }
  | { status: 'rejected'; errors: string[] };

/**
 * Publishes an uploaded bundle: validates it, copies its files to versioned
 * public keys, writes the episode manifest and rebuilds the feed. The result
 * is written to the bundle's status key for the CLI to read.
 *
 * A bundle for an episode that already exists replaces the files it
 * contains and keeps the rest, so it can carry new details only, or one
 * corrected file.
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

  // Derived from the bundle when absent, so the second pass after
  // transcoding arrives at the same guid.
  const guid = input.guid ?? uuidV5(`${slug}/${bundleId}`, DARKRELAY_NAMESPACE);
  const id = episodeId(guid);
  const previousRaw = await store.getText(layout.episodeManifest(slug, id));
  const previous = previousRaw ? EpisodeManifest.parse(JSON.parse(previousRaw)) : undefined;

  const { files, errors: fileErrors, ignored } = classifyBundle(names);
  errors.push(...fileErrors.filter((e) => !(previous && e === NO_MEDIA_ERROR)));
  if (files.chapters) {
    const chapters = await store.getText(prefix + files.chapters);
    try {
      errors.push(...validateChapters(JSON.parse(chapters ?? '')));
    } catch {
      errors.push('chapters.json is not valid JSON');
    }
  }
  if (errors.length > 0) return { status: 'rejected', errors };

  const processedRaw = await store.getText(prefix + PROCESSED_FILE);
  const processed = processedRaw ? ProcessedResult.parse(JSON.parse(processedRaw)) : undefined;
  if (processed && !processed.ok) {
    return { status: 'rejected', errors: [`Video processing failed: ${processed.error}`] };
  }
  if (!processed) {
    const hlsPrefix = `${publicKey(layout.episodeAsset(slug, id, bundleId, 'hls'))}/`;
    const job = planProcessing(files, show, deps.bucketName, prefix, hlsPrefix);
    if (job) {
      await deps.startTranscode(job);
      return { status: 'processing', guid, episodeId: id, job };
    }
  }
  if (!files.audio && (files.video || !previous)) {
    return { status: 'rejected', errors: ['Video processing finished but produced no audio'] };
  }
  const hls = processed?.ok ? processed.hls : undefined;

  const copyTo = async (name: string) => {
    const key = layout.episodeAsset(slug, id, bundleId, name.toLowerCase());
    await store.copy(prefix + name, publicKey(key), {
      contentType: contentTypeFor(name),
      cacheControl: MEDIA_CACHE_CONTROL,
    });
    return { key };
  };

  const audio = files.audio;
  const enclosure = audio
    ? {
        asset: await copyTo(audio),
        length: objects.find((o) => o.key === prefix + audio)!.size,
        type: contentTypeFor(audio),
      }
    : previous!.enclosure;
  const manifestInput: EpisodeManifestInput = {
    schemaVersion: 1,
    guid,
    guidIsPermaLink: previous ? previous.guidIsPermaLink : false,
    status: input.status ?? previous?.status ?? 'published',
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
    thumbnail: files.thumbnail ? await copyTo(files.thumbnail) : previous?.thumbnail,
    enclosure,
    alternateEnclosures: hls
      ? [
          {
            asset: { key: hls.masterKey.slice(PUBLIC_PREFIX.length) },
            type: 'application/x-mpegURL',
            title: 'Video',
            height: Math.max(...hls.renditions.map((r) => r.height)),
            bitrate: Math.max(...hls.renditions.map((r) => r.bandwidth)),
          },
        ]
      : (previous?.alternateEnclosures ?? []),
    transcripts: files.transcripts.length
      ? await Promise.all(
          files.transcripts.map(async (t) => ({
            asset: await copyTo(t.file),
            type: t.type,
            language: input.transcriptLanguage ?? show.language,
          })),
        )
      : (previous?.transcripts ?? []),
    chapters: files.chapters ? await copyTo(files.chapters) : previous?.chapters,
    persons: input.persons,
    keywords: input.keywords,
    video: files.video ? await copyTo(files.video) : previous?.video,
    // Without the link, a republished episode would look new to the YouTube uploader.
    youtube: previous?.youtube,
    // An episode.json without `youtube` keeps the copy it had; `"youtube": {}` clears it.
    youtubeCopy: emptyToUndefined(input.youtube ?? previous?.youtubeCopy),
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
    scheduledFor:
      Date.parse(manifest.pubDate) > deps.now().getTime() ? manifest.pubDate : undefined,
    ignoredFiles: ignored,
  };
}

function emptyToUndefined<T extends object>(o: T | undefined): T | undefined {
  return o && Object.values(o).some((v) => v !== undefined) ? o : undefined;
}
