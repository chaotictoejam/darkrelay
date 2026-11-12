import {
  ContentItem,
  SHORTS_MANIFEST_FILE,
  ShortsManifest,
  contentIdFor,
  episodeId,
  layout,
  outletsOfKind,
  type BrandConfig,
  type ContentItemInput,
  type ShortsManifestItem,
} from '@darkrelay/core';
import { z } from 'zod';
import type { Store } from '../lib/store';

export interface IngestDeps {
  store: Store;
  loadBrand(brand: string): Promise<BrandConfig | undefined>;
  /** Episode guids of the brand's feed, to resolve `parentId`. */
  episodeGuids(brand: string): Promise<string[]>;
  now(): Date;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface BatchResult {
  batchId: string;
  brand: string;
  status: 'ingested' | 'rejected';
  outlet?: string;
  items: { id: string; title: string; publishAt?: string }[];
  errors: string[];
  updatedAt: string;
}

/**
 * A batch arrives the way a bundle does: the media first, then the manifest,
 * whose arrival is what starts this. Nothing is written unless the whole
 * batch is good — a half-ingested batch is worse than a rejected one,
 * because you cannot tell by looking which half made it.
 */
export async function ingestBatch(
  deps: IngestDeps,
  brandSlug: string,
  batchId: string,
): Promise<BatchResult> {
  const { store } = deps;
  const prefix = layout.inboxPrefix(brandSlug, batchId);
  const now = deps.now();
  const reject = async (...errors: string[]): Promise<BatchResult> => {
    const result: BatchResult = {
      batchId,
      brand: brandSlug,
      status: 'rejected',
      items: [],
      errors,
      updatedAt: now.toISOString(),
    };
    await writeStatus(store, result);
    deps.log('Shorts batch rejected', { brand: brandSlug, batchId, errors });
    return result;
  };

  const raw = await store.getText(prefix + SHORTS_MANIFEST_FILE);
  if (raw === undefined) return reject(`No ${SHORTS_MANIFEST_FILE} in the batch`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return reject(`${SHORTS_MANIFEST_FILE} is not valid JSON: ${String(e)}`);
  }
  const parsed = ShortsManifest.safeParse(json);
  if (!parsed.success) return reject(...z.prettifyError(parsed.error).split('\n'));
  const manifest = parsed.data;
  if (manifest.brand && manifest.brand !== brandSlug) {
    return reject(
      `Manifest says brand "${manifest.brand}" but it was uploaded under "${brandSlug}"`,
    );
  }

  const brand = await deps.loadBrand(brandSlug);
  if (!brand) return reject(`No brand "${brandSlug}"`);
  const channels = outletsOfKind(brand, 'youtube');
  const outlet = manifest.outlet ?? channels[0]?.id;
  if (!outlet) {
    return reject(
      `${brandSlug} has no YouTube outlet to publish to. Add one: darkrelay brand outlet add ${brandSlug} --kind youtube --connection <name>`,
    );
  }
  if (!brand.outlets.some((o) => o.id === outlet)) {
    return reject(`${brandSlug} has no outlet "${outlet}"`);
  }

  const present = new Set((await store.list(prefix)).map((o) => o.key.slice(prefix.length)));
  const guids = new Set(await deps.episodeGuids(brandSlug));
  const errors: string[] = [];
  const ids = new Set<string>();
  const planned: { item: ContentItemInput; file: string; thumbnail?: string }[] = [];

  for (const [index, short] of manifest.shorts.entries()) {
    const where = `shorts[${index}] (${short.file})`;
    if (!present.has(short.file)) {
      errors.push(`${where}: no such file in the batch`);
      continue;
    }
    if (short.thumbnail && !present.has(short.thumbnail)) {
      errors.push(`${where}: thumbnail "${short.thumbnail}" is not in the batch`);
      continue;
    }
    const id = short.id ?? contentIdFor(short.file, batchId);
    if (ids.has(id)) {
      errors.push(`${where}: two shorts would share the id "${id}"; give one an "id"`);
      continue;
    }
    ids.add(id);
    const parentId = resolveParent(short, manifest.defaults?.parentId, guids);
    if (short.parentId && !parentId) {
      errors.push(`${where}: no episode with guid or id "${short.parentId}"`);
      continue;
    }
    planned.push({
      file: short.file,
      thumbnail: short.thumbnail,
      item: {
        schemaVersion: 1,
        id,
        brand: brandSlug,
        kind: manifest.kind,
        title: short.title,
        description: short.description ?? manifest.defaults?.description ?? '',
        tags: short.tags ?? manifest.defaults?.tags ?? [],
        parentId,
        media: { key: layout.contentMedia(brandSlug, id, short.file) },
        thumbnail: short.thumbnail
          ? { key: layout.contentMedia(brandSlug, id, short.thumbnail) }
          : undefined,
        publishAt: short.publishAt,
        publications: [{ outlet, state: 'planned', publishAt: short.publishAt, warnings: [] }],
        batchId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
  }

  const validated: ContentItem[] = [];
  for (const [index, { item }] of planned.entries()) {
    const result = ContentItem.safeParse(item);
    if (result.success) validated.push(result.data);
    else errors.push(`shorts[${index}]: ${z.prettifyError(result.error).replace(/\n/g, '; ')}`);
  }
  if (errors.length) return reject(...errors);

  // Everything checked out: copy the media, then write the records.
  for (const [index, { file, thumbnail }] of planned.entries()) {
    const item = validated[index]!;
    await store.copy(prefix + file, layout.contentMedia(brandSlug, item.id, file));
    if (thumbnail) {
      await store.copy(prefix + thumbnail, layout.contentMedia(brandSlug, item.id, thumbnail));
    }
    const key = layout.contentItem(brandSlug, item.id);
    // A re-uploaded batch must not undo what has already been published.
    const existing = await store.getText(key);
    const merged = existing ? keepPublished(item, ContentItem.parse(JSON.parse(existing))) : item;
    await store.put(key, JSON.stringify(merged, null, 2), { contentType: 'application/json' });
  }

  const result: BatchResult = {
    batchId,
    brand: brandSlug,
    status: 'ingested',
    outlet,
    items: validated.map((i) => ({ id: i.id, title: i.title, publishAt: i.publishAt })),
    errors: [],
    updatedAt: now.toISOString(),
  };
  await writeStatus(store, result);
  deps.log('Shorts batch ingested', { brand: brandSlug, batchId, items: validated.length, outlet });
  return result;
}

/**
 * A `parentId` may be written as the episode's guid, which is what a human
 * has to hand, or as the episode id DarkRelay derives from it.
 */
function resolveParent(
  short: ShortsManifestItem,
  fallback: string | undefined,
  guids: Set<string>,
): string | undefined {
  const given = short.parentId ?? fallback;
  if (!given) return undefined;
  if (guids.has(given)) return episodeId(given);
  if (/^[0-9a-f]{16}$/.test(given) && [...guids].some((g) => episodeId(g) === given)) return given;
  return undefined;
}

/**
 * Re-ingesting a batch refreshes the copy but never rewinds an outlet that
 * has already had the video: the platform's id and the time it was given are
 * facts about the world, not something a manifest can restate.
 */
function keepPublished(fresh: ContentItem, existing: ContentItem): ContentItem {
  const publications = fresh.publications.map((p) => {
    const was = existing.publications.find((e) => e.outlet === p.outlet);
    return was && was.state !== 'planned' ? { ...was, publishAt: p.publishAt ?? was.publishAt } : p;
  });
  const kept = existing.publications.filter(
    (e) => !publications.some((p) => p.outlet === e.outlet),
  );
  return {
    ...fresh,
    // A slot already assigned stays unless the manifest names a new one.
    publishAt: fresh.publishAt ?? existing.publishAt,
    publications: [...publications, ...kept],
    createdAt: existing.createdAt,
  };
}

async function writeStatus(store: Store, result: BatchResult) {
  await store.put(
    layout.inboxStatus(result.brand, result.batchId),
    JSON.stringify(result, null, 2),
    { contentType: 'application/json' },
  );
}
