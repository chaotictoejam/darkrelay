import {
  GoogleApiError,
  UploadState,
  contentTypeFor,
  youtubeMetadataHash,
  type YouTube,
  type YouTubeVideo,
} from '@darkrelay/core';
import type { Store } from '../lib/store';

/** 64 MiB: a multiple of 256 KiB, as resumable uploads require. */
export const CHUNK_BYTES = 64 * 1024 * 1024;
/** Leave this much of the Lambda's time to save state and hand off. */
export const RESERVE_MS = 90_000;
/** An "uploading" state untouched this long is presumed dead and taken over. */
export const STALE_MS = 30 * 60_000;

export interface TransferDeps {
  store: Store;
  timeLeftMs(): number;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface TransferTarget {
  /** Bucket key of the media to send. */
  videoKey: string;
  /** Where the resumable state lives, so a hand-off can pick it up. */
  stateKey: string;
  /** The YouTube video resource: snippet and status. */
  resource: { snippet: Record<string, unknown>; status: Record<string, unknown> };
}

export type TransferResult =
  | { done: true; video: YouTubeVideo }
  /** Out of time. The state is saved; re-invoke and call this again. */
  | { done: false };

export async function readJson<T>(
  store: Store,
  key: string,
  parse: (v: unknown) => T,
): Promise<T | undefined> {
  const raw = await store.getText(key);
  return raw === undefined ? undefined : parse(JSON.parse(raw));
}

export async function saveState(store: Store, key: string, state: UploadState, now: Date) {
  state.updatedAt = now.toISOString();
  await store.put(key, JSON.stringify(state, null, 2), { contentType: 'application/json' });
}

/** A fresh upload state, before any bytes have been sent. */
export function newUploadState(now: Date): UploadState {
  return {
    state: 'uploading',
    offset: 0,
    warnings: [],
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** True when an `uploading` state has been untouched long enough to take over. */
export function isStale(state: UploadState, now: Date): boolean {
  return now.getTime() - Date.parse(state.updatedAt) > STALE_MS;
}

/**
 * Sends a video to YouTube in chunks, resuming wherever the state left off
 * and handing back control before the Lambda's time runs out. Shared by
 * episode uploads and by the just-in-time Shorts uploader, so there is one
 * implementation of the awkward parts: session creation, chunk retries after
 * a dropped connection, and the hand-off.
 *
 * `state` is mutated and saved as it goes; the caller owns what happens to
 * it afterwards.
 */
export async function transferVideo(
  deps: TransferDeps,
  yt: YouTube,
  target: TransferTarget,
  state: UploadState,
): Promise<TransferResult> {
  const { store } = deps;

  if (!state.sessionUri || state.videoKey !== target.videoKey) {
    const head = await store.head(target.videoKey);
    if (!head) throw new Error(`Video file missing: ${target.videoKey}`);
    state.sessionUri = await yt.startUpload(
      target.resource,
      head.size,
      contentTypeFor(target.videoKey),
    );
    state.total = head.size;
    state.offset = 0;
    state.videoKey = target.videoKey;
    state.metadataHash = youtubeMetadataHash(
      target.resource.snippet as Parameters<typeof youtubeMetadataHash>[0],
    );
    await saveState(store, target.stateKey, state, deps.now());
  }

  const total = state.total!;
  for (;;) {
    if (deps.timeLeftMs() < RESERVE_MS) {
      await saveState(store, target.stateKey, state, deps.now());
      deps.log('Upload handed off', { stateKey: target.stateKey, offset: state.offset, total });
      return { done: false };
    }
    let result;
    if (state.offset >= total) {
      result = await yt.uploadStatus(state.sessionUri!, total);
    } else {
      const end = Math.min(state.offset + CHUNK_BYTES, total) - 1;
      const body = await store.getRange(target.videoKey, state.offset, end);
      try {
        result = await yt.uploadChunk(state.sessionUri!, body, state.offset, total);
      } catch (e) {
        // A dropped connection or a 5xx: ask the session where it got to and carry on.
        if (e instanceof GoogleApiError && e.status < 500) throw e;
        deps.log('Chunk failed; checking upload status', { error: String(e) });
        result = await yt.uploadStatus(state.sessionUri!, total);
      }
    }
    if (result.done) return { done: true, video: result.video };
    state.offset = result.next;
    await saveState(store, target.stateKey, state, deps.now());
  }
}

/**
 * The warning YouTube's API audit earns you: a project that has not passed
 * it can only ever create private videos, whatever privacy was asked for.
 */
export function auditWarning(requested: string, video: YouTubeVideo): string | undefined {
  if (requested === 'private') return undefined;
  // A video scheduled with publishAt is private on purpose, not by the audit.
  if (video.status?.privacyStatus !== 'private' || video.status.publishAt) return undefined;
  return 'YouTube made this upload private. Uploads from a Google Cloud project that has not passed the YouTube API audit are always private; make it public in YouTube Studio, or request the audit.';
}
