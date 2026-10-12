import {
  EpisodeManifest,
  UploadState,
  contentTypeFor,
  layout,
  publicKey,
  validateChapters,
  youtubeMetadata,
  type ShowConfig,
  GoogleApiError,
  type YouTube,
  type YouTubeVideo,
} from '@darkrelay/core';
import type { Store } from '../lib/store';
import { loadShow } from '../publisher/feed';

/** 64 MiB: a multiple of 256 KiB, as resumable uploads require. */
export const CHUNK_BYTES = 64 * 1024 * 1024;
/** Leave this much of the Lambda's time to save state and hand off. */
const RESERVE_MS = 90_000;
/** An "uploading" state untouched this long is presumed dead and taken over. */
const STALE_MS = 30 * 60_000;

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

async function readJson<T>(
  store: Store,
  key: string,
  parse: (v: unknown) => T,
): Promise<T | undefined> {
  const raw = await store.getText(key);
  return raw === undefined ? undefined : parse(JSON.parse(raw));
}

/**
 * Runs whenever an episode manifest changes. Uploads the episode's video to
 * YouTube once, keeps a scheduled video's release time in step with the
 * episode, and does nothing otherwise. Safe to run any number of times.
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

  if (manifest.youtube && !event.force) return syncSchedule(deps, show, manifest, manifestKey);
  if (!manifest.video || !('key' in manifest.video)) return 'no-video';
  if (!show.youtube.upload && !event.force) return 'manual';

  const stateKey = layout.youtubeUpload(event.show, event.episodeId);
  const now = deps.now();
  let state = await readJson(store, stateKey, (v) => UploadState.parse(v));
  if (state?.state === 'done' && state.videoId && !event.force) {
    // Finished before the manifest was updated (e.g. a crash in between).
    await linkVideo(deps, manifestKey, manifest, state.videoId, show);
    return 'already';
  }
  if (state?.state === 'uploading' && !event.continuation) {
    const stale = now.getTime() - Date.parse(state.updatedAt) > STALE_MS;
    if (!stale) return 'in-progress';
    deps.log('Taking over a stalled upload', { stateKey });
  }
  if (!state || state.state !== 'uploading' || event.force) {
    const fresh: UploadState = {
      state: 'uploading',
      offset: 0,
      warnings: [],
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
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

async function save(store: Store, key: string, state: UploadState, now: Date) {
  state.updatedAt = now.toISOString();
  await store.put(key, JSON.stringify(state, null, 2), { contentType: 'application/json' });
}

function isFuture(iso: string, now: Date) {
  return Date.parse(iso) > now.getTime();
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

  if (!state.sessionUri || state.videoKey !== videoKey) {
    const head = await store.head(videoKey);
    if (!head) throw new Error(`Video file missing: ${videoKey}`);
    const chapters =
      manifest.chapters && 'key' in manifest.chapters
        ? await store
            .getText(publicKey(manifest.chapters.key))
            .then((t) => (t ? JSON.parse(t) : undefined))
        : undefined;
    const usable = chapters && validateChapters(chapters).length === 0 ? chapters : undefined;
    const resource = videoResource(show, manifest, usable, deps.now());
    state.sessionUri = await yt.startUpload(resource, head.size, contentTypeFor(videoKey));
    state.total = head.size;
    state.offset = 0;
    state.videoKey = videoKey;
    await save(store, stateKey, state, deps.now());
  }

  const total = state.total!;
  let video: YouTubeVideo | undefined;
  while (!video) {
    if (deps.timeLeftMs() < RESERVE_MS) {
      await save(store, stateKey, state, deps.now());
      await deps.continueLater({ show: show.slug, episodeId: event.episodeId, continuation: true });
      deps.log('Upload handed off', { stateKey, offset: state.offset, total });
      return 'continuing';
    }
    let result;
    if (state.offset >= total) {
      result = await yt.uploadStatus(state.sessionUri!, total);
    } else {
      const end = Math.min(state.offset + CHUNK_BYTES, total) - 1;
      const body = await store.getRange(videoKey, state.offset, end);
      try {
        result = await yt.uploadChunk(state.sessionUri!, body, state.offset, total);
      } catch (e) {
        // A dropped connection or a 5xx: ask the session where it got to and carry on.
        if (e instanceof GoogleApiError && e.status < 500) throw e;
        deps.log('Chunk failed; checking upload status', { error: String(e) });
        result = await yt.uploadStatus(state.sessionUri!, total);
      }
    }
    if (result.done) video = result.video;
    else {
      state.offset = result.next;
      await save(store, stateKey, state, deps.now());
    }
  }

  state.videoId = video.id;
  const requested = show.youtube!.privacy;
  if (
    requested !== 'private' &&
    video.status?.privacyStatus === 'private' &&
    !video.status.publishAt
  ) {
    state.warnings.push(
      'YouTube made this upload private. Uploads from a Google Cloud project that has not passed the YouTube API audit are always private; make it public in YouTube Studio, or request the audit.',
    );
  }
  await addExtras(deps, yt, show, manifest, video.id, state);
  await linkVideo(deps, manifestKey, manifest, video.id, show);
  await save(store, stateKey, { ...state, state: 'done', sessionUri: undefined }, deps.now());
  deps.log('Uploaded to YouTube', { stateKey, videoId: video.id, warnings: state.warnings });
  return 'uploaded';
}

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
  const image = manifest.image && 'key' in manifest.image ? manifest.image.key : undefined;
  if (image) {
    await attempt('Thumbnail (custom thumbnails need a verified channel)', async () => {
      const key = publicKey(image);
      const head = await deps.store.head(key);
      if (!head) return;
      await yt.setThumbnail(
        videoId,
        await deps.store.getRange(key, 0, head.size - 1),
        contentTypeFor(key),
      );
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
  videoId: string,
  show: ShowConfig,
) {
  const now = deps.now();
  const scheduled = show.youtube!.privacy === 'public' && isFuture(manifest.pubDate, now);
  const updated = EpisodeManifest.parse({
    ...manifest,
    youtube: {
      videoId,
      linkedAt: now.toISOString(),
      publishAt: scheduled ? new Date(manifest.pubDate).toISOString() : undefined,
    },
    updatedAt: now.toISOString(),
  });
  await deps.store.put(manifestKey, JSON.stringify(updated, null, 2), {
    contentType: 'application/json',
  });
}

/**
 * Keeps a scheduled YouTube video in step with its episode: rescheduling the
 * episode moves the video's publishAt too. Released videos are left alone.
 */
async function syncSchedule(
  deps: UploadDeps,
  show: ShowConfig,
  manifest: EpisodeManifest,
  manifestKey: string,
): Promise<UploadOutcome> {
  const yt = manifest.youtube!;
  const now = deps.now();
  if (!yt.publishAt || !isFuture(yt.publishAt, now)) return 'already';
  const target = new Date(manifest.pubDate).toISOString();
  if (target === yt.publishAt) return 'already';
  const client = await deps.youtubeFor(show.youtube!.connection);
  await client.updateStatus(
    yt.videoId,
    isFuture(target, now)
      ? { privacyStatus: 'private', publishAt: target, selfDeclaredMadeForKids: false }
      : { privacyStatus: show.youtube!.privacy, selfDeclaredMadeForKids: false },
  );
  const updated = EpisodeManifest.parse({
    ...manifest,
    youtube: { ...yt, publishAt: isFuture(target, now) ? target : undefined },
    updatedAt: now.toISOString(),
  });
  await deps.store.put(manifestKey, JSON.stringify(updated, null, 2), {
    contentType: 'application/json',
  });
  return 'synced';
}
