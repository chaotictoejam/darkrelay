import {
  EpisodeManifest,
  UploadState,
  contentTypeFor,
  layout,
  publicKey,
  validateChapters,
  youtubeMetadata,
  youtubeMetadataHash,
  type ShowConfig,
  type YouTube,
} from '@darkrelay/core';
import type { Store } from '../lib/store';
import { loadShow } from '../publisher/feed';
import {
  auditWarning,
  isStale,
  newUploadState,
  readJson,
  saveState as save,
  transferVideo,
} from './transfer';

export { CHUNK_BYTES } from './transfer';

export interface UploadDeps {
  store: Store;
  youtubeFor(connection: string): Promise<YouTube>;
  /** Re-invokes the worker to carry on where this one stopped. */
  continueLater(event: UploadEvent): Promise<void>;
  timeLeftMs(): number;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface UploadEvent {
  show: string;
  episodeId: string;
  /** Upload even if the show uploads manually or the episode was uploaded before. */
  force?: boolean;
  /** Set on hand-offs between invocations of the same upload. */
  continuation?: boolean;
  /**
   * Send the title and description to the episode's video now, even if
   * unchanged or linked rather than uploaded (`darkrelay youtube sync`).
   */
  pushMetadata?: boolean;
}

export type UploadOutcome =
  | 'no-youtube'
  | 'no-episode'
  | 'no-video'
  | 'manual'
  | 'hidden'
  | 'already'
  | 'synced'
  | 'in-progress'
  | 'continuing'
  | 'uploaded'
  | 'failed';

/**
 * Runs whenever an episode manifest changes. Uploads the episode's video to
 * YouTube once, then keeps the video in step with the episode: a rescheduled
 * episode moves its publishAt, and changed metadata updates the title and
 * description of videos DarkRelay uploaded. Safe to run any number of times.
 */
export async function onEpisodeChanged(
  deps: UploadDeps,
  event: UploadEvent,
): Promise<UploadOutcome> {
  const { store } = deps;
  const show = await loadShow(store, event.show);
  if (!show?.youtube) return 'no-youtube';
  const manifestKey = layout.episodeManifest(event.show, event.episodeId);
  const manifest = await readJson(store, manifestKey, (v) => EpisodeManifest.parse(v));
  if (!manifest) return 'no-episode';
  if (manifest.status === 'hidden') return 'hidden';

  if (manifest.youtube && !event.force) return syncVideo(deps, show, manifest, manifestKey, event);
  if (!manifest.video || !('key' in manifest.video)) return 'no-video';
  if (!show.youtube.upload && !event.force) return 'manual';

  const stateKey = layout.youtubeUpload(event.show, event.episodeId);
  const now = deps.now();
  let state = await readJson(store, stateKey, (v) => UploadState.parse(v));
  if (state?.state === 'done' && state.videoId && !event.force) {
    // Finished before the manifest was updated (e.g. a crash in between).
    await linkVideo(deps, manifestKey, manifest, state, show);
    return 'already';
  }
  if (state?.state === 'uploading' && !event.continuation) {
    if (!isStale(state, now)) return 'in-progress';
    deps.log('Taking over a stalled upload', { stateKey });
  }
  if (!state || state.state !== 'uploading' || event.force) {
    const fresh = newUploadState(now);
    // Only one worker may start an upload; a second event loses this race.
    if (!state && !(await store.createIfAbsent(stateKey, JSON.stringify(fresh))))
      return 'in-progress';
    state = fresh;
    await save(store, stateKey, state, now);
  }

  try {
    return await upload(deps, show, manifest, manifestKey, stateKey, state, event);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log('YouTube upload failed', { stateKey, error: message });
    await save(store, stateKey, { ...state, state: 'failed', error: message }, deps.now());
    return 'failed';
  }
}

function isFuture(iso: string, now: Date) {
  return Date.parse(iso) > now.getTime();
}

/** The episode's chapters file, if it has a valid one. */
async function loadChapters(store: Store, manifest: EpisodeManifest): Promise<unknown> {
  if (!manifest.chapters || !('key' in manifest.chapters)) return undefined;
  const text = await store.getText(publicKey(manifest.chapters.key));
  const chapters = text ? JSON.parse(text) : undefined;
  return chapters && validateChapters(chapters).length === 0 ? chapters : undefined;
}

/** Video resource for the upload: metadata plus privacy, scheduled if the episode is. */
export function videoResource(
  show: ShowConfig,
  manifest: EpisodeManifest,
  chapters: unknown,
  now: Date,
) {
  const yt = show.youtube!;
  const meta = youtubeMetadata({
    title: manifest.title,
    descriptionHtml: manifest.description,
    copy: manifest.youtubeCopy,
    chapters: Array.isArray((chapters as { chapters?: unknown })?.chapters)
      ? (chapters as { chapters: { startTime: number; title?: string }[] }).chapters
      : undefined,
    footer: yt.descriptionFooter,
    tags: [...yt.tags, ...manifest.keywords],
  });
  const scheduled = yt.privacy === 'public' && isFuture(manifest.pubDate, now);
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: yt.categoryId,
      defaultLanguage: show.language,
      defaultAudioLanguage: show.language,
    },
    status: {
      // YouTube only schedules private videos; it makes them public at publishAt.
      privacyStatus: scheduled ? 'private' : yt.privacy,
      ...(scheduled ? { publishAt: new Date(manifest.pubDate).toISOString() } : {}),
      selfDeclaredMadeForKids: false,
    },
  };
}

async function upload(
  deps: UploadDeps,
  show: ShowConfig,
  manifest: EpisodeManifest,
  manifestKey: string,
  stateKey: string,
  state: UploadState,
  event: UploadEvent,
): Promise<UploadOutcome> {
  const { store } = deps;
  const yt = await deps.youtubeFor(show.youtube!.connection);
  const videoKey = publicKey((manifest.video as { key: string }).key);
  const resource = videoResource(show, manifest, await loadChapters(store, manifest), deps.now());

  const result = await transferVideo(deps, yt, { videoKey, stateKey, resource }, state);
  if (!result.done) {
    await deps.continueLater({ show: show.slug, episodeId: event.episodeId, continuation: true });
    return 'continuing';
  }
  const video = result.video;

  state.videoId = video.id;
  const warning = auditWarning(show.youtube!.privacy, video);
  if (warning) state.warnings.push(warning);
  await addExtras(deps, yt, show, manifest, video.id, state);
  await linkVideo(deps, manifestKey, manifest, state, show);
  await save(store, stateKey, { ...state, state: 'done', sessionUri: undefined }, deps.now());
  deps.log('Uploaded to YouTube', { stateKey, videoId: video.id, warnings: state.warnings });
  return 'uploaded';
}

/** The image YouTube gets as the thumbnail: the episode's thumbnail, else its artwork. */
export function thumbnailKeyOf(manifest: EpisodeManifest): string | undefined {
  for (const ref of [manifest.thumbnail, manifest.image]) if (ref && 'key' in ref) return ref.key;
  return undefined;
}

async function setThumbnail(deps: UploadDeps, yt: YouTube, videoId: string, image: string) {
  const key = publicKey(image);
  const head = await deps.store.head(key);
  if (!head) throw new Error(`Image missing: ${key}`);
  await yt.setThumbnail(
    videoId,
    await deps.store.getRange(key, 0, head.size - 1),
    contentTypeFor(key),
  );
}

const THUMBNAIL_WARNING = 'Thumbnail (custom thumbnails need a verified channel)';

/** Thumbnail, captions and playlist. Each is best effort: a failure is a warning, not a failed upload. */
async function addExtras(
  deps: UploadDeps,
  yt: YouTube,
  show: ShowConfig,
  manifest: EpisodeManifest,
  videoId: string,
  state: UploadState,
) {
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      state.warnings.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const image = thumbnailKeyOf(manifest);
  if (image) {
    await attempt(THUMBNAIL_WARNING, async () => {
      await setThumbnail(deps, yt, videoId, image);
      state.thumbnailKey = image;
    });
  }
  const transcript =
    manifest.transcripts.find((t) => t.type === 'text/vtt' && 'key' in t.asset) ??
    manifest.transcripts.find((t) => t.type === 'application/x-subrip' && 'key' in t.asset);
  if (transcript) {
    await attempt('Captions', async () => {
      const key = publicKey((transcript.asset as { key: string }).key);
      const head = await deps.store.head(key);
      if (!head) return;
      await yt.insertCaption(
        videoId,
        transcript.language ?? show.language,
        await deps.store.getRange(key, 0, head.size - 1),
      );
    });
  }
  if (show.youtube!.playlistId) {
    await attempt('Playlist', () => yt.addToPlaylist(show.youtube!.playlistId!, videoId));
  }
}

async function linkVideo(
  deps: UploadDeps,
  manifestKey: string,
  manifest: EpisodeManifest,
  state: UploadState,
  show: ShowConfig,
) {
  const now = deps.now();
  const scheduled = show.youtube!.privacy === 'public' && isFuture(manifest.pubDate, now);
  const updated = EpisodeManifest.parse({
    ...manifest,
    youtube: {
      videoId: state.videoId!,
      linkedAt: now.toISOString(),
      publishAt: scheduled ? new Date(manifest.pubDate).toISOString() : undefined,
      metadataHash: state.metadataHash,
      thumbnailKey: state.thumbnailKey,
    },
    updatedAt: now.toISOString(),
  });
  await deps.store.put(manifestKey, JSON.stringify(updated, null, 2), {
    contentType: 'application/json',
  });
}

/**
 * Keeps an episode's video in step with the episode. Rescheduling moves a
 * scheduled video's publishAt (released videos are left alone). Changed
 * metadata updates the title and description, but only of videos DarkRelay
 * uploaded: a linked video was made elsewhere, and is only written to by
 * `darkrelay youtube sync --force`. A new thumbnail or artwork is sent to
 * uploaded videos too.
 */
async function syncVideo(
  deps: UploadDeps,
  show: ShowConfig,
  manifest: EpisodeManifest,
  manifestKey: string,
  event: UploadEvent,
): Promise<UploadOutcome> {
  const yt = manifest.youtube!;
  const now = deps.now();
  const next = { ...yt };
  let client: YouTube | undefined;
  const youtube = async () => (client ??= await deps.youtubeFor(show.youtube!.connection));

  if (yt.publishAt && isFuture(yt.publishAt, now)) {
    const target = new Date(manifest.pubDate).toISOString();
    if (target !== yt.publishAt) {
      await (
        await youtube()
      ).updateStatus(
        yt.videoId,
        isFuture(target, now)
          ? { privacyStatus: 'private', publishAt: target, selfDeclaredMadeForKids: false }
          : { privacyStatus: show.youtube!.privacy, selfDeclaredMadeForKids: false },
      );
      next.publishAt = isFuture(target, now) ? target : undefined;
    }
  }

  const stateKey = layout.youtubeUpload(event.show, event.episodeId);
  const state = await readJson(deps.store, stateKey, (v) => UploadState.parse(v));
  const uploaded = state?.state === 'done' && state.videoId === yt.videoId;
  let pushed = false;
  if (uploaded || event.pushMetadata) {
    const { snippet } = videoResource(
      show,
      manifest,
      await loadChapters(deps.store, manifest),
      now,
    );
    const hash = youtubeMetadataHash(snippet);
    // Uploaded before hashes were kept: its YouTube copy may have been edited
    // in Studio since. Adopt it as the baseline unless the episode now has
    // copy of its own for YouTube.
    const baseline = yt.metadataHash === undefined && !manifest.youtubeCopy;
    if (event.pushMetadata || (!baseline && hash !== yt.metadataHash)) {
      try {
        await (await youtube()).updateSnippet(yt.videoId, snippet);
        pushed = true;
        deps.log('Updated YouTube metadata', { videoId: yt.videoId });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        deps.log('YouTube metadata update failed', { videoId: yt.videoId, error: message });
        if (state) {
          state.warnings.push(`Updating title and description: ${message}`);
          await save(deps.store, stateKey, state, now);
        }
        throw e;
      }
    }
    if (pushed || baseline) next.metadataHash = hash;
  }

  // Uploads from before thumbnailKey was kept were given the artwork.
  const image = thumbnailKeyOf(manifest);
  const sentImage =
    yt.thumbnailKey ?? (manifest.image && 'key' in manifest.image ? manifest.image.key : undefined);
  if (uploaded && image && image !== sentImage) {
    try {
      await setThumbnail(deps, await youtube(), yt.videoId, image);
      next.thumbnailKey = image;
      pushed = true;
      deps.log('Updated YouTube thumbnail', { videoId: yt.videoId });
    } catch (e) {
      // Best effort, as on upload; tried again the next time the episode changes.
      const message = e instanceof Error ? e.message : String(e);
      deps.log('YouTube thumbnail update failed', { videoId: yt.videoId, error: message });
      const warning = `${THUMBNAIL_WARNING}: ${message}`;
      if (!state!.warnings.includes(warning)) {
        state!.warnings.push(warning);
        await save(deps.store, stateKey, state!, now);
      }
    }
  }

  const scheduleMoved = next.publishAt !== yt.publishAt;
  if (
    scheduleMoved ||
    next.metadataHash !== yt.metadataHash ||
    next.thumbnailKey !== yt.thumbnailKey
  ) {
    const updated = EpisodeManifest.parse({
      ...manifest,
      youtube: next,
      updatedAt: now.toISOString(),
    });
    await deps.store.put(manifestKey, JSON.stringify(updated, null, 2), {
      contentType: 'application/json',
    });
  }
  return scheduleMoved || pushed ? 'synced' : 'already';
}
