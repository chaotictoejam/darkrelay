import {
  EpisodeInput,
  PROCESSED_FILE,
  SLUG,
  canUpload,
  classifyBundle,
  contentTypeFor,
  layout,
  type Access,
  type EpisodeInputRaw,
} from '@darkrelay/core';
import { z } from 'zod';
import type { Store } from '../lib/store';

export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

/** S3 multipart uploads, signed for the browser to send the bytes itself. */
export interface Multipart {
  create(key: string, contentType: string): Promise<string>;
  signPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  complete(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
}

export interface UploadDeps {
  store: Pick<Store, 'getText' | 'head' | 'list' | 'createIfAbsent'>;
  multipart: Multipart;
  /** Show slugs under catalog/. */
  listShows(): Promise<string[]>;
  newBundleId(): string;
  newGuid(): string;
}

export interface UploadRequest {
  method: string;
  path: string;
  body: unknown;
  access: Access;
}

/** Big enough for a 3-hour 1080p video; S3 allows 10,000 parts per upload. */
export const MAX_FILE_BYTES = 50 * 1024 ** 3;
const MIN_PART = 16 * 1024 ** 2;
const MAX_PARTS = 10_000;
/** Part URLs are signed in batches as the upload goes, so each can expire quickly. */
export const SIGN_BATCH = 100;

const BUNDLE_ID = /^\d{14}-[0-9a-f]{6}$/;
/** The publisher's own files; a browser upload must never write them. */
const RESERVED = new Set(['episode.json', PROCESSED_FILE]);

const error = (statusCode: number, message: string | string[]): ApiResponse => ({
  statusCode,
  body: Array.isArray(message)
    ? { error: message.join('\n'), errors: message }
    : { error: message },
});
const FORBIDDEN = error(403, "You can't upload to this show");

export function partSize(bytes: number): number {
  const min = Math.ceil(bytes / MAX_PARTS / (1024 * 1024)) * 1024 * 1024;
  return Math.max(MIN_PART, min);
}

const CreateBody = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(10),
});

const SignBody = z.object({
  name: z.string().min(1),
  uploadId: z.string().min(1),
  parts: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(SIGN_BATCH),
});

const FileDoneBody = z.object({
  name: z.string().min(1),
  uploadId: z.string().min(1),
  parts: z
    .array(
      z.object({ partNumber: z.number().int().min(1).max(MAX_PARTS), etag: z.string().min(1) }),
    )
    .min(1)
    .max(MAX_PARTS),
});

/** The form fields. The rest of episode.json is filled in here. */
const CompleteBody = z.object({
  title: z.string(),
  description: z.string(),
  pubDate: z.string().optional(),
  durationSeconds: z.number(),
  season: z.number().optional(),
  episode: z.number().optional(),
  episodeType: z.enum(['full', 'trailer', 'bonus']).optional(),
  explicit: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T | ApiResponse {
  const r = schema.safeParse(body);
  return r.success
    ? r.data
    : error(
        400,
        r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
}
const isResponse = (v: unknown): v is ApiResponse =>
  typeof v === 'object' && v !== null && 'statusCode' in v;

/** A bundle file the dashboard may write: a known role, never the publisher's own files. */
function badName(name: string): string | undefined {
  if (RESERVED.has(name.toLowerCase())) return `${name} is written by DarkRelay, not uploaded`;
  if (name !== name.toLowerCase() || classifyBundle([name, 'audio.mp3']).ignored.length)
    return `${name} is not a bundle file name`;
  return undefined;
}

/**
 * Routes the dashboard's upload API. Every route checks the caller's role
 * for the show; the UI hiding a button is not the protection.
 */
export async function route(deps: UploadDeps, req: UploadRequest): Promise<ApiResponse> {
  const parts = req.path.split('/').filter(Boolean);
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'me') return me(deps, req.access);

  if (parts[0] !== 'shows' || parts[2] !== 'uploads') return error(404, 'Not found');
  const show = parts[1]!;
  if (!SLUG.test(show)) return error(400, 'Bad show');
  if (!canUpload(req.access, show)) return FORBIDDEN;
  if (!(await deps.store.head(layout.showConfig(show))))
    return error(404, `Show "${show}" does not exist`);

  if (parts.length === 3 && req.method === 'POST') return create(deps, show, req.body);

  const bundleId = parts[3];
  if (!bundleId || !BUNDLE_ID.test(bundleId)) return error(400, 'Bad upload id');
  if (parts.length === 4 && req.method === 'GET') return status(deps, show, bundleId);
  if (parts.length === 5 && req.method === 'POST') {
    if (parts[4] === 'parts') return sign(deps, show, bundleId, req.body);
    if (parts[4] === 'files') return fileDone(deps, show, bundleId, req.body);
    if (parts[4] === 'complete') return complete(deps, show, bundleId, req.body);
  }
  return error(404, 'Not found');
}

/** What the signed-in user may do, so the dashboard knows what to offer. */
async function me(deps: UploadDeps, access: Access): Promise<ApiResponse> {
  const slugs = access.admin ? await deps.listShows() : [...access.upload].sort();
  const upload = (
    await Promise.all(
      slugs.map(async (show) => {
        const raw = await deps.store.getText(layout.showConfig(show));
        if (raw === undefined) return undefined;
        let title = show;
        try {
          title = String((JSON.parse(raw) as { title?: unknown }).title ?? show);
        } catch {
          // A broken show.json still has a slug to upload to.
        }
        return { show, title };
      }),
    )
  ).filter((s) => s !== undefined);
  return {
    statusCode: 200,
    body: { admin: access.admin, view: access.admin ? null : [...access.view].sort(), upload },
  };
}

async function create(deps: UploadDeps, show: string, body: unknown): Promise<ApiResponse> {
  const input = parse(CreateBody, body);
  if (isResponse(input)) return input;
  const names = input.files.map((f) => f.name);
  const errors = names.map(badName).filter((e) => e !== undefined);
  if (new Set(names).size !== names.length) errors.push('The same file name appears twice');
  if (!errors.length) errors.push(...classifyBundle(names).errors);
  if (errors.length) return error(400, errors);

  const bundleId = deps.newBundleId();
  const prefix = layout.inboxPrefix(show, bundleId);
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
  return { statusCode: 201, body: { bundleId, files } };
}

/** Writing is over once episode.json is in place; the publisher owns the bundle from then on. */
async function sealed(deps: UploadDeps, show: string, bundleId: string) {
  return (await deps.store.head(layout.inboxPrefix(show, bundleId) + 'episode.json')) !== undefined;
}

async function sign(
  deps: UploadDeps,
  show: string,
  bundleId: string,
  body: unknown,
): Promise<ApiResponse> {
  const input = parse(SignBody, body);
  if (isResponse(input)) return input;
  const bad = badName(input.name);
  if (bad) return error(400, bad);
  if (await sealed(deps, show, bundleId)) return error(409, 'This upload is already submitted');
  const key = layout.inboxPrefix(show, bundleId) + input.name;
  const urls: Record<number, string> = {};
  for (const n of new Set(input.parts))
    urls[n] = await deps.multipart.signPart(key, input.uploadId, n);
  return { statusCode: 200, body: { urls } };
}

async function fileDone(
  deps: UploadDeps,
  show: string,
  bundleId: string,
  body: unknown,
): Promise<ApiResponse> {
  const input = parse(FileDoneBody, body);
  if (isResponse(input)) return input;
  const bad = badName(input.name);
  if (bad) return error(400, bad);
  if (await sealed(deps, show, bundleId)) return error(409, 'This upload is already submitted');
  const key = layout.inboxPrefix(show, bundleId) + input.name;
  const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
  await deps.multipart.complete(key, input.uploadId, parts);
  const head = await deps.store.head(key);
  return { statusCode: 200, body: { name: input.name, size: head?.size ?? 0 } };
}

/**
 * Writes episode.json from the form, which hands the bundle to the
 * publisher exactly as a CLI upload does. Validated against the bundle
 * schema here so mistakes come back to the form, not the status page.
 */
async function complete(
  deps: UploadDeps,
  show: string,
  bundleId: string,
  body: unknown,
): Promise<ApiResponse> {
  const form = parse(CompleteBody, body);
  if (isResponse(form)) return form;
  const prefix = layout.inboxPrefix(show, bundleId);
  const names = (await deps.store.list(prefix)).map((o) => o.key.slice(prefix.length));
  if (names.includes('episode.json')) return error(409, 'This upload is already submitted');
  if (!names.length) return error(404, 'No files uploaded for this upload id');
  const { errors } = classifyBundle(names);
  if (errors.length) return error(400, errors);

  const raw: EpisodeInputRaw = {
    schemaVersion: 1,
    show,
    guid: deps.newGuid(),
    title: form.title.trim(),
    description: form.description.trim(),
    pubDate: form.pubDate || undefined,
    durationSeconds: Math.round(form.durationSeconds),
    season: form.season,
    episode: form.episode,
    episodeType: form.episodeType,
    explicit: form.explicit,
  };
  const parsed = EpisodeInput.safeParse(raw);
  if (!parsed.success) {
    return error(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const written = await deps.store.createIfAbsent(
    prefix + 'episode.json',
    JSON.stringify(parsed.data, null, 2),
    {
      contentType: 'application/json',
    },
  );
  if (!written) return error(409, 'This upload is already submitted');
  return { statusCode: 202, body: { bundleId, guid: parsed.data.guid, status: 'queued' } };
}

/** The publisher's verdict, or where the upload has got to before there is one. */
async function status(deps: UploadDeps, show: string, bundleId: string): Promise<ApiResponse> {
  const raw = await deps.store.getText(layout.inboxStatus(show, bundleId));
  if (raw) {
    const { job: _job, ...result } = JSON.parse(raw) as Record<string, unknown>;
    return { statusCode: 200, body: { bundleId, ...result } };
  }
  const prefix = layout.inboxPrefix(show, bundleId);
  const names = (await deps.store.list(prefix)).map((o) => o.key.slice(prefix.length));
  if (names.includes('episode.json'))
    return { statusCode: 200, body: { bundleId, status: 'queued' } };
  if (names.length) return { statusCode: 200, body: { bundleId, status: 'uploading' } };
  return error(404, 'No upload with this id (results are kept for 30 days)');
}
