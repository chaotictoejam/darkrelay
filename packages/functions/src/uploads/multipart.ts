import { z } from 'zod';
import { error, isResponse, parse, type ApiResponse } from '../lib/http';
import type { Store } from '../lib/store';

/**
 * Browser-side S3 multipart uploads, signed one batch of parts at a time.
 * Episode bundles and Shorts batches both land in the inbox this way, so the
 * signing, the retry window and the part arithmetic live here rather than
 * once per kind of upload.
 */
export interface Multipart {
  create(key: string, contentType: string): Promise<string>;
  signPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  complete(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
}

/** Big enough for a 3-hour 1080p video; S3 allows 10,000 parts per upload. */
export const MAX_FILE_BYTES = 50 * 1024 ** 3;
const MIN_PART = 16 * 1024 ** 2;
export const MAX_PARTS = 10_000;
/** Part URLs are signed in batches as the upload goes, so each can expire quickly. */
export const SIGN_BATCH = 100;

export function partSize(bytes: number): number {
  const min = Math.ceil(bytes / MAX_PARTS / (1024 * 1024)) * 1024 * 1024;
  return Math.max(MIN_PART, min);
}

export const SignBody = z.object({
  name: z.string().min(1),
  uploadId: z.string().min(1),
  parts: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(SIGN_BATCH),
});

export const FileDoneBody = z.object({
  name: z.string().min(1),
  uploadId: z.string().min(1),
  parts: z
    .array(
      z.object({ partNumber: z.number().int().min(1).max(MAX_PARTS), etag: z.string().min(1) }),
    )
    .min(1)
    .max(MAX_PARTS),
});

/**
 * What the part routes need to know about one upload in progress: where its
 * files go, which names it may write, and whether it has been handed over
 * already — once the manifest is in place the upload belongs to whatever
 * picks it up, and the browser must not write to it again.
 */
export interface Transfer {
  multipart: Multipart;
  store: Pick<Store, 'head'>;
  /** Key prefix of the upload in the inbox, ending in a slash. */
  prefix: string;
  /** The problem with this file name, if there is one. */
  badName(name: string): string | undefined;
  /** True once the manifest has been written and the upload is submitted. */
  sealed(): Promise<boolean>;
}

const SUBMITTED = error(409, 'This upload is already submitted');

/** Signs the next parts of one file, after checking the upload is still open. */
export async function signParts(transfer: Transfer, body: unknown): Promise<ApiResponse> {
  const input = parse(SignBody, body);
  if (isResponse(input)) return input;
  const bad = transfer.badName(input.name);
  if (bad) return error(400, bad);
  if (await transfer.sealed()) return SUBMITTED;
  const key = transfer.prefix + input.name;
  const urls: Record<number, string> = {};
  for (const n of new Set(input.parts))
    urls[n] = await transfer.multipart.signPart(key, input.uploadId, n);
  return { statusCode: 200, body: { urls } };
}

/** Completes one file's multipart upload, which is what puts it in the inbox. */
export async function completeFile(transfer: Transfer, body: unknown): Promise<ApiResponse> {
  const input = parse(FileDoneBody, body);
  if (isResponse(input)) return input;
  const bad = transfer.badName(input.name);
  if (bad) return error(400, bad);
  if (await transfer.sealed()) return SUBMITTED;
  const key = transfer.prefix + input.name;
  const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
  await transfer.multipart.complete(key, input.uploadId, parts);
  const head = await transfer.store.head(key);
  return { statusCode: 200, body: { name: input.name, size: head?.size ?? 0 } };
}
