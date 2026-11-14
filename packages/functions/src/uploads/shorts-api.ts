import {
  SHORTS_MANIFEST_FILE,
  SLUG,
  STORED_KINDS,
  ShortsManifest,
  canUpload,
  contentTypeFor,
  layout,
  outletsOfKind,
  type Access,
  type BrandConfig,
  type ShortsManifestInput,
} from '@darkrelay/core';
import { z } from 'zod';
import { error, isResponse, parse, type ApiResponse } from '../lib/http';
import type { Store } from '../lib/store';
import {
  MAX_FILE_BYTES,
  completeFile,
  partSize,
  signParts,
  type Multipart,
  type Transfer,
} from './multipart';

/**
 * The dashboard's Shorts upload: a batch of clips, uploaded from the browser
 * the way `darkrelay shorts put` uploads a directory. The media goes to the
 * inbox first and the manifest goes last, because its arrival is what starts
 * the ingest — the same contract the CLI keeps, so one batch cannot be
 * half-ingested whichever way it was sent.
 *
 * These routes are brand-scoped, not show-scoped: a Short goes to a channel,
 * and a brand with only a YouTube outlet has no show.json to hang an upload
 * off. Every route checks `uploader` on the brand; the UI hiding a button is
 * never the protection.
 */

export interface ShortsUploadDeps {
  store: Pick<Store, 'getText' | 'head' | 'list' | 'createIfAbsent'>;
  multipart: Multipart;
  loadBrand(brand: string): Promise<BrandConfig | undefined>;
  newBundleId(): string;
  now(): Date;
}

export interface ShortsUploadRequest {
  method: string;
  path: string;
  body: unknown;
  access: Access;
}

/** One batch is a handful of clips, not a quarter's worth at once. */
export const MAX_BATCH_FILES = 60;

const BATCH_ID = /^\d{14}-[0-9a-f]{6}$/;
/** Plain file names, so an inbox key never needs escaping. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEDIA_EXT = ['mp4', 'mov', 'm4v', 'webm'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png'];
/** Written by DarkRelay or the transcoder; a browser upload must not write them. */
const RESERVED = new Set([SHORTS_MANIFEST_FILE, 'episode.json', 'processed.json']);

const FORBIDDEN = error(403, 'You need the uploader role on this brand to upload Shorts');

/**
 * All the picker needs of an episode. Deliberately not the whole manifest
 * schema: an episode DarkRelay cannot fully parse is still an episode a clip
 * came from, and leaving it out of the list would be the wrong way to say so.
 */
const EpisodeRow = z.object({ title: z.string().min(1), pubDate: z.string().min(1) });

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** The problem with a file name in a batch, if there is one. */
export function badBatchName(name: string): string | undefined {
  if (RESERVED.has(name.toLowerCase())) return `${name} is written by DarkRelay, not uploaded`;
  if (!FILE_NAME.test(name))
    return `${name}: use letters, digits, dots, dashes and underscores only`;
  const e = ext(name);
  if (![...MEDIA_EXT, ...IMAGE_EXT].includes(e))
    return `${name}: expected a video (${MEDIA_EXT.join(', ')}) or an image (${IMAGE_EXT.join(', ')})`;
  return undefined;
}

const CreateBody = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        size: z.number().int().positive().max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_BATCH_FILES),
});

/** The manifest as the form sends it: the brand comes from the path. */
const CompleteBody = z.object({
  kind: z.enum(STORED_KINDS).optional(),
  outlet: z.string().max(40).optional(),
  defaults: z
    .object({
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      parentId: z.string().optional(),
    })
    .optional(),
  shorts: z.array(z.unknown()).min(1).max(MAX_BATCH_FILES),
});

/**
 * Routes a Shorts upload. `GET` on the collection is what the form opens
 * with: which channels the brand has, and which episodes a clip can name as
 * its parent.
 */
export async function route(
  deps: ShortsUploadDeps,
  req: ShortsUploadRequest,
): Promise<ApiResponse> {
  const parts = req.path.split('/').filter(Boolean);
  if ((parts[0] !== 'brands' && parts[0] !== 'shows') || parts[2] !== 'shorts')
    return error(404, 'Not found');
  const slug = parts[1]!;
  if (!SLUG.test(slug)) return error(400, 'Bad brand');
  if (!canUpload(req.access, slug)) return FORBIDDEN;
  const brand = await deps.loadBrand(slug);
  if (!brand) return error(404, `No brand "${slug}" in this deployment`);

  if (parts.length === 3) {
    if (req.method === 'GET') return formContext(deps, brand);
    if (req.method === 'POST') return create(deps, slug, req.body);
    return error(405, 'Method not allowed');
  }

  const batchId = parts[3]!;
  if (!BATCH_ID.test(batchId)) return error(400, 'Bad batch id');
  const transfer = transferFor(deps, slug, batchId);

  if (parts.length === 4 && req.method === 'GET') return status(deps, slug, batchId);
  if (parts.length === 5 && req.method === 'POST') {
    if (parts[4] === 'parts') return signParts(transfer, req.body);
    if (parts[4] === 'files') return completeFile(transfer, req.body);
    if (parts[4] === 'complete') return complete(deps, brand, batchId, req.body);
  }
  return error(404, 'Not found');
}

function transferFor(deps: ShortsUploadDeps, brand: string, batchId: string): Transfer {
  const prefix = layout.inboxPrefix(brand, batchId);
  return {
    multipart: deps.multipart,
    store: deps.store,
    prefix,
    badName: badBatchName,
    // Writing is over once the manifest is in place: the ingest owns the
    // batch from that moment, and it is all-or-nothing.
    sealed: async () => (await deps.store.head(prefix + SHORTS_MANIFEST_FILE)) !== undefined,
  };
}

/**
 * What the upload form needs before anything is picked: the brand's channels,
 * and its episodes so a clip can say which one it came from. A brand with no
 * YouTube outlet is told so here rather than after an upload.
 */
async function formContext(deps: ShortsUploadDeps, brand: BrandConfig): Promise<ApiResponse> {
  const channels = outletsOfKind(brand, 'youtube');
  const episodes = await listEpisodes(deps, brand);
  return {
    statusCode: 200,
    body: {
      brand: brand.slug,
      title: brand.name,
      timezone: brand.timezone,
      outlets: channels.map((o) => ({
        id: o.id,
        label: o.label ?? o.channelTitle ?? o.connection,
      })),
      episodes,
      maxFiles: MAX_BATCH_FILES,
    },
  };
}

/**
 * The brand's episodes, newest first, as `parentId` options. A clip names its
 * parent by the episode id the ingest derives from the guid, which is what
 * the feed's own manifests carry.
 */
async function listEpisodes(deps: ShortsUploadDeps, brand: BrandConfig) {
  const shows = new Set(
    outletsOfKind(brand, 'rss')
      .map((o) => o.show)
      .concat(brand.slug),
  );
  const episodes: { episodeId: string; title: string; pubDate: string }[] = [];
  for (const show of shows) {
    const prefix = layout.episodesPrefix(show);
    const keys = (await deps.store.list(prefix))
      .map((o) => o.key)
      .filter((k) => k.endsWith('.json') && !k.slice(prefix.length).includes('/'));
    for (const key of keys) {
      const raw = await deps.store.getText(key);
      if (!raw) continue;
      const parsed = EpisodeRow.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      episodes.push({
        episodeId: key.slice(prefix.length, -'.json'.length),
        title: parsed.data.title,
        pubDate: parsed.data.pubDate,
      });
    }
  }
  return episodes.sort((a, b) => b.pubDate.localeCompare(a.pubDate)).slice(0, 200);
}

/** Opens a batch: one multipart upload per file, all under one batch id. */
async function create(deps: ShortsUploadDeps, brand: string, body: unknown): Promise<ApiResponse> {
  const input = parse(CreateBody, body);
  if (isResponse(input)) return input;
  const names = input.files.map((f) => f.name);
  const errors = names.map(badBatchName).filter((e) => e !== undefined);
  if (new Set(names).size !== names.length) errors.push('The same file name appears twice');
  if (!names.some((n) => MEDIA_EXT.includes(ext(n))))
    errors.push('A batch needs at least one video file');
  if (errors.length) return error(400, errors);

  const batchId = deps.newBundleId();
  const prefix = layout.inboxPrefix(brand, batchId);
  const files = await Promise.all(
    input.files.map(async (f) => {
      const size = partSize(f.size);
      return {
        name: f.name,
        uploadId: await deps.multipart.create(prefix + f.name, contentTypeFor(f.name)),
        partSize: size,
        partCount: Math.max(1, Math.ceil(f.size / size)),
      };
    }),
  );
  return { statusCode: 201, body: { batchId, files } };
}

/**
 * Writes shorts.json, which hands the batch to the ingest exactly as a CLI
 * upload does. Validated here — the schema, the files named, the outlet — so
 * a mistake comes back to the form while it can still be fixed, instead of
 * arriving as a rejected batch.
 */
async function complete(
  deps: ShortsUploadDeps,
  brand: BrandConfig,
  batchId: string,
  body: unknown,
): Promise<ApiResponse> {
  const form = parse(CompleteBody, body);
  if (isResponse(form)) return form;
  const manifest: ShortsManifestInput = {
    schemaVersion: 1,
    brand: brand.slug,
    kind: form.kind ?? 'short',
    outlet: form.outlet,
    defaults: form.defaults,
    // Zod checks the items; the route only knows there is at least one.
    shorts: form.shorts as ShortsManifestInput['shorts'],
  };
  const parsed = ShortsManifest.safeParse(manifest);
  if (!parsed.success) {
    return error(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }

  const channels = outletsOfKind(brand, 'youtube');
  const outlet = parsed.data.outlet ?? channels[0]?.id;
  if (!outlet) {
    return error(
      400,
      `${brand.slug} has no YouTube channel to publish to. Connect one with "darkrelay youtube connect", then add it as an outlet.`,
    );
  }
  if (!brand.outlets.some((o) => o.id === outlet)) {
    return error(400, `${brand.slug} has no outlet "${outlet}"`);
  }

  const prefix = layout.inboxPrefix(brand.slug, batchId);
  const present = new Set((await deps.store.list(prefix)).map((o) => o.key.slice(prefix.length)));
  if (present.has(SHORTS_MANIFEST_FILE)) return error(409, 'This batch is already submitted');
  const errors: string[] = [];
  for (const [index, short] of parsed.data.shorts.entries()) {
    const where = `shorts[${index}] (${short.file})`;
    for (const [name, what] of [
      [short.file, 'file'],
      [short.thumbnail, 'thumbnail'],
    ] as const) {
      if (name === undefined) continue;
      const bad = badBatchName(name);
      if (bad) errors.push(`${where}: ${bad}`);
      else if (!present.has(name)) errors.push(`${where}: ${what} "${name}" was not uploaded`);
    }
    if (short.thumbnail && !IMAGE_EXT.includes(ext(short.thumbnail)))
      errors.push(`${where}: a thumbnail must be a JPEG or PNG`);
    if (!MEDIA_EXT.includes(ext(short.file)))
      errors.push(`${where}: ${short.file} is not a video file`);
  }
  const files = parsed.data.shorts.map((s) => s.file);
  const duplicate = files.find((f, i) => files.indexOf(f) !== i);
  if (duplicate) errors.push(`${duplicate} appears twice; each clip is uploaded once`);
  if (errors.length) return error(400, errors);

  // Last, and only once: the manifest landing is what starts the ingest.
  const written = await deps.store.createIfAbsent(
    prefix + SHORTS_MANIFEST_FILE,
    JSON.stringify({ ...parsed.data, outlet }, null, 2),
    { contentType: 'application/json' },
  );
  if (!written) return error(409, 'This batch is already submitted');
  return {
    statusCode: 202,
    body: { batchId, status: 'queued', items: parsed.data.shorts.length, outlet },
  };
}

/** The ingest's verdict, or where the upload has got to before there is one. */
async function status(
  deps: ShortsUploadDeps,
  brand: string,
  batchId: string,
): Promise<ApiResponse> {
  const raw = await deps.store.getText(layout.inboxStatus(brand, batchId));
  if (raw) return { statusCode: 200, body: JSON.parse(raw) };
  const prefix = layout.inboxPrefix(brand, batchId);
  const names = (await deps.store.list(prefix)).map((o) => o.key.slice(prefix.length));
  if (names.includes(SHORTS_MANIFEST_FILE))
    return { statusCode: 200, body: { batchId, brand, status: 'queued' } };
  if (names.length) return { statusCode: 200, body: { batchId, brand, status: 'uploading' } };
  return error(404, 'No batch with this id (results are kept for 7 days)');
}
