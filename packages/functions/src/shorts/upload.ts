import {
  ContentItem,
  UploadState,
  contentTypeFor,
  dueForUpload,
  feedShow,
  layout,
  needsReschedule,
  outletsOfKind,
  publicationFor,
  withPublication,
  youtubeDefaults,
  youtubeMetadata,
  type BrandConfig,
  type Publication,
  type ShowConfig,
  type YouTube,
  type YouTubeOutlet,
} from '@darkrelay/core';
import type { Store } from '../lib/store';
import {
  auditWarning,
  isStale,
  newUploadState,
  readJson,
  saveState,
  transferVideo,
} from '../youtube/transfer';

/**
 * How many videos one channel may be given in a day. A YouTube upload costs
 * 1,600 of the default 10,000 daily quota units, so six is the ceiling and
 * five leaves room for the thumbnail, playlist and metadata calls around
 * them. This is what stops a quarter's worth of Shorts going up at once.
 */
export const DEFAULT_DAILY_UPLOADS = 5;

export interface ShortsUploadDeps {
  store: Store;
  brands(): Promise<BrandConfig[]>;
  loadShow(show: string): Promise<ShowConfig | undefined>;
  youtubeFor(connection: string): Promise<YouTube>;
  continueLater(event: UploadEvent): Promise<void>;
  timeLeftMs(): number;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface UploadEvent {
  brand: string;
  id: string;
  outlet?: string;
  /** Upload even if the slot is further off than the lead time. */
  force?: boolean;
  continuation?: boolean;
}

export type ContentOutcome =
  | 'no-content'
  | 'no-outlet'
  | 'no-slot'
  | 'already'
  | 'in-progress'
  | 'continuing'
  | 'uploaded'
  | 'rescheduled'
  | 'failed';

async function loadItem(store: Store, brand: string, id: string) {
  return readJson(store, layout.contentItem(brand, id), (v) => ContentItem.parse(v));
}

async function saveItem(store: Store, item: ContentItem, now: Date) {
  const updated = { ...item, updatedAt: now.toISOString() };
  await store.put(layout.contentItem(item.brand, item.id), JSON.stringify(updated, null, 2), {
    contentType: 'application/json',
  });
  return updated;
}

function channelFor(brand: BrandConfig, outlet?: string): YouTubeOutlet | undefined {
  const channels = outletsOfKind(brand, 'youtube');
  return outlet ? channels.find((c) => c.id === outlet) : channels[0];
}

/**
 * The video resource for a piece of content. A slot in the future is sent as
 * a private video with `publishAt`, which is the only way YouTube schedules
 * anything; a slot in the past goes out at the outlet's own privacy.
 */
export function contentResource(
  item: ContentItem,
  outlet: YouTubeOutlet,
  show: ShowConfig | undefined,
  now: Date,
) {
  const defaults = youtubeDefaults(outlet, show);
  const meta = youtubeMetadata({
    title: item.title,
    descriptionHtml: '',
    copy: { title: item.title, description: item.description || undefined },
    footer: defaults.descriptionFooter,
    tags: [...defaults.tags, ...item.tags],
  });
  const scheduled =
    defaults.privacy === 'public' && !!item.publishAt && Date.parse(item.publishAt) > now.getTime();
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: defaults.categoryId,
    },
    status: {
      privacyStatus: scheduled ? 'private' : defaults.privacy,
      ...(scheduled ? { publishAt: new Date(item.publishAt!).toISOString() } : {}),
      selfDeclaredMadeForKids: false,
    },
    scheduled,
  };
}

/**
 * Uploads one piece of content to one outlet, resuming across invocations
 * the way an episode upload does. Safe to call repeatedly: an item already
 * sent to that outlet is left alone.
 */
export async function uploadContent(
  deps: ShortsUploadDeps,
  event: UploadEvent,
): Promise<ContentOutcome> {
  const { store } = deps;
  const now = deps.now();
  const brand = (await deps.brands()).find((b) => b.slug === event.brand);
  if (!brand) return 'no-content';
  const outlet = channelFor(brand, event.outlet);
  if (!outlet) return 'no-outlet';
  let item = await loadItem(store, event.brand, event.id);
  if (!item) return 'no-content';

  const publication = publicationFor(item, outlet.id);
  if (publication?.state === 'published' || publication?.state === 'scheduled') {
    return needsReschedule(item, outlet.id) ? reschedule(deps, brand, item, outlet) : 'already';
  }
  if (!item.publishAt && !event.force) return 'no-slot';

  const stateKey = layout.contentUpload(event.brand, event.id);
  let state = await readJson(store, stateKey, (v) => UploadState.parse(v));
  if (state?.state === 'uploading' && !event.continuation && !isStale(state, now)) {
    return 'in-progress';
  }
  if (!state || state.state !== 'uploading' || event.force) {
    const fresh = newUploadState(now);
    if (!state && !(await store.createIfAbsent(stateKey, JSON.stringify(fresh)))) {
      return 'in-progress';
    }
    state = fresh;
    await saveState(store, stateKey, state, now);
  }

  const feed = feedShow(brand);
  const show = feed ? await deps.loadShow(feed) : undefined;
  const { scheduled, ...resource } = contentResource(item, outlet, show, now);
  const videoKey = (item.media as { key: string }).key;

  try {
    const yt = await deps.youtubeFor(outlet.connection);
    const result = await transferVideo(deps, yt, { videoKey, stateKey, resource }, state);
    if (!result.done) {
      await deps.continueLater({ ...event, continuation: true });
      return 'continuing';
    }
    const video = result.video;
    state.videoId = video.id;
    const warning = auditWarning(resource.status['privacyStatus'] as string, video);
    if (warning) state.warnings.push(warning);
    await addExtras(deps, yt, item, outlet, show, video.id, state);

    item = withPublication(item, {
      outlet: outlet.id,
      state: scheduled ? 'scheduled' : 'published',
      externalId: video.id,
      publishAt: item.publishAt,
      sentPublishAt: scheduled ? item.publishAt : undefined,
      uploadedAt: now.toISOString(),
      warnings: state.warnings,
      updatedAt: now.toISOString(),
    });
    await saveItem(store, item, now);
    await saveState(store, stateKey, { ...state, state: 'done', sessionUri: undefined }, now);
    deps.log('Uploaded content to YouTube', {
      brand: item.brand,
      id: item.id,
      videoId: video.id,
      publishAt: item.publishAt,
      warnings: state.warnings,
    });
    return 'uploaded';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log('Content upload failed', { brand: event.brand, id: event.id, error: message });
    await saveState(store, stateKey, { ...state, state: 'failed', error: message }, now);
    const failed = await loadItem(store, event.brand, event.id);
    if (failed) {
      const previous = publicationFor(failed, outlet.id);
      const marked: Publication = {
        outlet: outlet.id,
        state: 'failed',
        externalId: previous?.externalId,
        publishAt: failed.publishAt,
        uploadedAt: previous?.uploadedAt,
        sentPublishAt: previous?.sentPublishAt,
        error: message,
        warnings: previous?.warnings ?? [],
        updatedAt: now.toISOString(),
      };
      await saveItem(store, withPublication(failed, marked), now);
    }
    return 'failed';
  }
}

/** Thumbnail and playlist. Best effort: a failure is a warning, not a failed upload. */
async function addExtras(
  deps: ShortsUploadDeps,
  yt: YouTube,
  item: ContentItem,
  outlet: YouTubeOutlet,
  show: ShowConfig | undefined,
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
  if (item.thumbnail && 'key' in item.thumbnail) {
    const key = item.thumbnail.key;
    await attempt('Thumbnail (custom thumbnails need a verified channel)', async () => {
      const head = await deps.store.head(key);
      if (!head) throw new Error(`Image missing: ${key}`);
      await yt.setThumbnail(
        videoId,
        await deps.store.getRange(key, 0, head.size - 1),
        contentTypeFor(key),
      );
      state.thumbnailKey = key;
    });
  }
  const playlistId = youtubeDefaults(outlet, show).playlistId;
  if (playlistId) await attempt('Playlist', () => yt.addToPlaylist(playlistId, videoId));
}

/**
 * The slot moved after the video was uploaded, so YouTube is holding the
 * wrong release time. Moving it into the past releases it now.
 */
async function reschedule(
  deps: ShortsUploadDeps,
  brand: BrandConfig,
  item: ContentItem,
  outlet: YouTubeOutlet,
): Promise<ContentOutcome> {
  const now = deps.now();
  const publication = publicationFor(item, outlet.id)!;
  const target = item.publishAt;
  const future = !!target && Date.parse(target) > now.getTime();
  const yt = await deps.youtubeFor(outlet.connection);
  const feed = feedShow(brand);
  const privacy = youtubeDefaults(outlet, feed ? await deps.loadShow(feed) : undefined).privacy;
  await yt.updateStatus(
    publication.externalId!,
    future
      ? { privacyStatus: 'private', publishAt: target, selfDeclaredMadeForKids: false }
      : { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  );
  await saveItem(
    deps.store,
    withPublication(item, {
      ...publication,
      state: future ? 'scheduled' : 'published',
      publishAt: target,
      sentPublishAt: future ? target : undefined,
      updatedAt: now.toISOString(),
    }),
    now,
  );
  deps.log('Moved a scheduled video', {
    brand: item.brand,
    id: item.id,
    videoId: publication.externalId,
    publishAt: target,
  });
  return 'rescheduled';
}

export interface SweepOptions {
  /** How far ahead of its slot an item is uploaded. */
  leadDays?: number;
  /** Per channel, per day. Protects the API quota. */
  dailyUploads?: number;
}

export interface SweepResult {
  uploaded: { brand: string; id: string; outcome: ContentOutcome }[];
  rescheduled: string[];
  /** Due, but held back because the day's upload allowance was used up. */
  deferred: string[];
}

/** Uploads already sent to this outlet on the same UTC day as `now`. */
export function uploadsToday(items: ContentItem[], outlet: string, now: Date): number {
  const today = now.toISOString().slice(0, 10);
  return items.filter((i) => publicationFor(i, outlet)?.uploadedAt?.slice(0, 10) === today).length;
}

/**
 * The hourly pass: uploads what is due in the next few days, moves anything
 * whose slot has changed, and stops once the day's allowance for a channel
 * is gone. Uploading days ahead is what makes an hourly pass precise enough.
 */
export async function sweepDue(
  deps: ShortsUploadDeps,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const now = deps.now();
  const dailyUploads = opts.dailyUploads ?? DEFAULT_DAILY_UPLOADS;
  const result: SweepResult = { uploaded: [], rescheduled: [], deferred: [] };

  for (const brand of await deps.brands()) {
    const channels = outletsOfKind(brand, 'youtube');
    if (!channels.length) continue;
    const items = await listContent(deps.store, brand.slug);
    if (!items.length) continue;

    for (const outlet of channels) {
      let budget = dailyUploads - uploadsToday(items, outlet.id, now);
      // Oldest slot first, so the next thing out is the next thing uploaded.
      const due = items
        .filter((i) => dueForUpload(i, outlet.id, now, opts.leadDays))
        .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
      for (const item of due) {
        if (budget <= 0) {
          result.deferred.push(`${brand.slug}/${item.id}`);
          continue;
        }
        const outcome = await uploadContent(deps, {
          brand: brand.slug,
          id: item.id,
          outlet: outlet.id,
        });
        result.uploaded.push({ brand: brand.slug, id: item.id, outcome });
        if (outcome === 'uploaded') budget--;
      }
      for (const item of items.filter((i) => needsReschedule(i, outlet.id))) {
        await uploadContent(deps, { brand: brand.slug, id: item.id, outlet: outlet.id });
        result.rescheduled.push(`${brand.slug}/${item.id}`);
      }
    }
  }
  deps.log('Swept scheduled content', {
    uploaded: result.uploaded.length,
    rescheduled: result.rescheduled.length,
    deferred: result.deferred.length,
  });
  return result;
}

/** Every content record of a brand. Media and upload state sit beside them. */
export async function listContent(store: Store, brand: string): Promise<ContentItem[]> {
  const items: ContentItem[] = [];
  for (const { key } of await store.list(layout.contentPrefix(brand))) {
    if (!key.endsWith('.json') || key.endsWith('.upload.json')) continue;
    const raw = await store.getText(key);
    if (raw === undefined) continue;
    const parsed = ContentItem.safeParse(JSON.parse(raw));
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}
