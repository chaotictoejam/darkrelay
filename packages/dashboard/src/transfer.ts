import { post } from './api';
import type { RuntimeConfig } from './auth';
import { bytes, partRanges } from './upload-plan';

/**
 * Sending one file's bytes straight to S3, in parts, with signed URLs the
 * API hands out a batch at a time. Episode bundles and Shorts batches both
 * upload this way: the only difference is the base path and what gets
 * written at the end.
 */

/** Parts in flight per file. */
const CONCURRENCY = 4;
const ATTEMPTS = 4;
/** Part URLs expire after 15 minutes; sign again well before that. */
const URL_MAX_AGE_MS = 10 * 60_000;
const SIGN_BATCH = 100;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PUTs one part straight to S3. Returns the part's ETag. */
export function putPart(url: string, body: Blob, onProgress: (loaded: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(etag ? `S3 returned HTTP ${xhr.status}` : 'S3 sent no ETag (CORS?)'));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(body);
  });
}

// One listener for the page: warn before leaving mid-upload.
let busy = false;
export const setBusy = (value: boolean) => (busy = value);
window.addEventListener('beforeunload', (e) => {
  if (busy) e.preventDefault();
});

/** One file's multipart upload, as the API opened it. */
export interface FileSpec {
  name: string;
  uploadId: string;
  partSize: number;
  partCount: number;
}

export interface FileJob {
  file: File;
  spec?: FileSpec;
  /** Finished parts survive a failed attempt, so Retry resumes rather than restarts. */
  etags: Map<number, string>;
  done: boolean;
  row: HTMLElement;
  bar: HTMLProgressElement;
  note: HTMLElement;
}

/** Sends a file's remaining parts, a few at a time, then completes it. */
export async function sendFile(config: RuntimeConfig, base: string, job: FileJob) {
  const spec = job.spec!;
  const ranges = partRanges(job.file.size, spec.partSize, spec.partCount);
  const queue = ranges.filter((r) => !job.etags.has(r.partNumber));
  const urls = new Map<number, { url: string; at: number }>();
  const inFlight = new Map<number, number>();
  const doneBytes = () =>
    ranges.filter((r) => job.etags.has(r.partNumber)).reduce((n, r) => n + r.end - r.start, 0);
  const progress = () => {
    const sent = doneBytes() + [...inFlight.values()].reduce((a, b) => a + b, 0);
    job.bar.value = job.file.size ? sent / job.file.size : 1;
    job.note.textContent = `${bytes(sent)} of ${bytes(job.file.size)}`;
  };

  const urlFor = async (n: number) => {
    const cached = urls.get(n);
    if (cached && Date.now() - cached.at < URL_MAX_AGE_MS) return cached.url;
    // Sign this part and the next ones still waiting, in one call.
    const wanted = [n, ...queue.map((r) => r.partNumber)].slice(0, SIGN_BATCH);
    const { urls: signed } = await post<{ urls: Record<string, string> }>(config, `${base}/parts`, {
      name: spec.name,
      uploadId: spec.uploadId,
      parts: wanted,
    });
    for (const [k, url] of Object.entries(signed)) urls.set(Number(k), { url, at: Date.now() });
    return urls.get(n)!.url;
  };

  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      for (let attempt = 1; ; attempt++) {
        try {
          const etag = await putPart(
            await urlFor(r.partNumber),
            job.file.slice(r.start, r.end),
            (loaded) => {
              inFlight.set(r!.partNumber, loaded);
              progress();
            },
          );
          job.etags.set(r.partNumber, etag);
          break;
        } catch (e) {
          urls.delete(r.partNumber);
          if (attempt >= ATTEMPTS) throw e;
          await sleep(1000 * 2 ** attempt);
        } finally {
          inFlight.delete(r.partNumber);
          progress();
        }
      }
    }
  };
  progress();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  await post(config, `${base}/files`, {
    name: spec.name,
    uploadId: spec.uploadId,
    parts: [...job.etags].map(([partNumber, etag]) => ({ partNumber, etag })),
  });
  job.done = true;
  job.bar.value = 1;
  job.note.textContent = `${bytes(job.file.size)}, uploaded`;
}

/**
 * Sends every file that still needs it, one after another, marking the row
 * that failed. Files already finished are skipped, so a retry resumes.
 */
export async function sendAll(config: RuntimeConfig, base: string, jobs: FileJob[]) {
  for (const job of jobs) {
    if (job.done) continue;
    job.row.classList.remove('failed');
    await sendFile(config, base, job).catch((e: unknown) => {
      job.row.classList.add('failed');
      job.note.textContent = `Failed: ${(e as Error).message}`;
      throw e;
    });
  }
}
