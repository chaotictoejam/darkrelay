import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  EpisodeManifest,
  MEDIA_CACHE_CONTROL,
  episodeId,
  layout,
  publicKey,
  type AssetRef,
} from '@darkrelay/core';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { loadEpisodes, loadShow } from './show';

export interface Fetched {
  body: Readable;
  contentType?: string;
  /** URL after redirects; its extension names the copied file. */
  finalUrl: string;
}

export interface MigrateDeps {
  fetch(url: string): Promise<Fetched>;
  upload(key: string, body: Readable, contentType: string): Promise<void>;
  now(): Date;
}

export interface AssetJob {
  role: string;
  url: string;
  contentType?: string;
  /** Byte count the feed promised. Checked for audio. */
  expectedLength?: number;
}

export interface CopiedAsset {
  role: string;
  key: string;
  bytes: number;
}

export class LengthMismatchError extends Error {}

/** Files of an episode that still live on another host. */
export function remoteAssets(m: EpisodeManifest): AssetJob[] {
  const jobs: AssetJob[] = [];
  const asset = m.enclosure.asset;
  if ('url' in asset) {
    jobs.push({
      role: 'audio',
      url: asset.url,
      contentType: m.enclosure.type,
      expectedLength: m.enclosure.length || undefined,
    });
  }
  if (m.image && 'url' in m.image) jobs.push({ role: 'cover', url: m.image.url });
  m.transcripts.forEach((t, i) => {
    if ('url' in t.asset)
      jobs.push({ role: `transcript-${i}`, url: t.asset.url, contentType: t.type });
  });
  if (m.chapters && 'url' in m.chapters) {
    jobs.push({ role: 'chapters', url: m.chapters.url, contentType: 'application/json' });
  }
  return jobs;
}

const EXT_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
  'application/srt': 'srt',
  'application/json': 'json',
  'text/html': 'html',
  'text/plain': 'txt',
};
const KNOWN_EXT = new Set([...Object.values(EXT_BY_TYPE), 'jpeg']);

export function extensionFor(finalUrl: string, contentType: string | undefined): string {
  const fromPath = new URL(finalUrl).pathname.split('.').pop()?.toLowerCase();
  if (fromPath && KNOWN_EXT.has(fromPath)) return fromPath === 'jpeg' ? 'jpg' : fromPath;
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return (type && EXT_BY_TYPE[type]) ?? 'bin';
}

/**
 * Copies one episode's remote files into the bucket and returns the updated
 * manifest. Throws without returning a manifest if any file fails, so the
 * episode keeps pointing at the old host until it can be fully copied.
 */
export async function migrateEpisode(
  slug: string,
  manifest: EpisodeManifest,
  deps: MigrateDeps,
): Promise<{ manifest: EpisodeManifest; copied: CopiedAsset[] }> {
  const id = episodeId(manifest.guid);
  const copied: CopiedAsset[] = [];
  const refs = new Map<string, AssetRef>();

  for (const job of remoteAssets(manifest)) {
    const res = await deps.fetch(job.url);
    const contentType =
      job.contentType ?? res.contentType?.split(';')[0] ?? 'application/octet-stream';
    const key = layout.episodeAsset(
      slug,
      id,
      'imported',
      `${job.role}.${extensionFor(res.finalUrl, contentType)}`,
    );
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    await deps.upload(publicKey(key), res.body.pipe(counter), contentType);
    if (job.expectedLength !== undefined && bytes !== job.expectedLength) {
      throw new LengthMismatchError(
        `${job.role}: downloaded ${bytes} bytes, feed says ${job.expectedLength} (${job.url})`,
      );
    }
    copied.push({ role: job.role, key, bytes });
    refs.set(job.role, { key });
  }

  const audio = copied.find((c) => c.role === 'audio');
  const updated = EpisodeManifest.parse({
    ...manifest,
    enclosure: {
      ...manifest.enclosure,
      asset: refs.get('audio') ?? manifest.enclosure.asset,
      length: manifest.enclosure.length || audio?.bytes || 0,
    },
    image: refs.get('cover') ?? manifest.image,
    transcripts: manifest.transcripts.map((t, i) => ({
      ...t,
      asset: refs.get(`transcript-${i}`) ?? t.asset,
    })),
    chapters: refs.get('chapters') ?? manifest.chapters,
    migratedFrom: {
      ...manifest.migratedFrom,
      ...Object.fromEntries(remoteAssets(manifest).map((j) => [j.role, j.url])),
    },
    updatedAt: deps.now().toISOString(),
  });
  return { manifest: updated, copied };
}

export async function httpFetch(url: string): Promise<Fetched> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'DarkRelay/0.1 (+https://github.com/chaotictoejam/darkrelay)' },
  });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return {
    body: Readable.fromWeb(res.body as WebReadableStream),
    contentType: res.headers.get('content-type') ?? undefined,
    finalUrl: res.url || url,
  };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/**
 * Step 2 of a migration: copies media from the old host into your bucket and
 * points the show's feed at it. Safe to re-run; finished episodes are skipped.
 */
export async function migrateMedia(
  slug: string,
  flags: { dryRun?: boolean; concurrency?: string },
  global: GlobalOptions,
) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const show = await loadShow(bucket, slug);
  if (!show) throw new Error(`Show "${slug}" does not exist`);

  const manifests = await loadEpisodes(bucket, slug);
  const pending = manifests
    .map((m) => ({ m, jobs: remoteAssets(m) }))
    .filter((p) => p.jobs.length > 0)
    .sort((a, b) => a.m.pubDate.localeCompare(b.m.pubDate));
  const showImageRemote = 'url' in show.image;
  const expected = pending.reduce((n, p) => n + (p.jobs[0]?.expectedLength ?? 0), 0);

  console.log(
    `${show.title}: ${pending.length} of ${manifests.length} episodes have files on another host (about ${mb(expected)} of audio).` +
      (showImageRemote ? ' Show artwork too.' : ''),
  );
  if (show.status === 'live' && pending.length > 0) {
    console.log('Show is live: the public feed will point at the copies as each episode finishes.');
  }
  if (flags.dryRun) {
    for (const { m, jobs } of pending) {
      console.log(`  ${m.pubDate.slice(0, 10)} ${m.title}: ${jobs.map((j) => j.role).join(', ')}`);
    }
    console.log('Dry run: nothing copied.');
    return;
  }

  const deps: MigrateDeps = {
    fetch: httpFetch,
    upload: (key, body, type) => bucket.uploadStream(key, body, type, MEDIA_CACHE_CONTROL),
    now: () => new Date(),
  };
  const failures: string[] = [];
  let done = 0;
  await pool(pending, Math.max(1, Number(flags.concurrency ?? 3)), async ({ m }) => {
    try {
      const { manifest, copied } = await migrateEpisode(slug, m, deps);
      await bucket.putText(
        layout.episodeManifest(slug, episodeId(m.guid)),
        JSON.stringify(manifest, null, 2),
      );
      const bytes = copied.reduce((n, c) => n + c.bytes, 0);
      console.log(
        `  [${++done}/${pending.length}] ${m.title}: ${copied.length} files, ${mb(bytes)}`,
      );
    } catch (e) {
      failures.push(`${m.title}: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`  [${++done}/${pending.length}] FAILED ${m.title}`);
    }
  });

  if (showImageRemote) {
    try {
      const res = await httpFetch((show.image as { url: string }).url);
      const chunks: Buffer[] = [];
      for await (const c of res.body) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
      const type = res.contentType?.split(';')[0] ?? 'image/jpeg';
      const key = `${slug}/cover-${hash}.${extensionFor(res.finalUrl, type)}`;
      await bucket.uploadStream(publicKey(key), Readable.from(body), type, 'public, max-age=86400');
      // Writing show.json also triggers the feed rebuild.
      await bucket.putText(
        layout.showConfig(slug),
        JSON.stringify({ ...show, image: { key } }, null, 2),
      );
      console.log('  Show artwork copied.');
    } catch (e) {
      failures.push(`show artwork: ${e instanceof Error ? e.message : String(e)}`);
      await bucket.putText(layout.rebuildRequest(slug), '', 'text/plain');
    }
  } else {
    await bucket.putText(layout.rebuildRequest(slug), '', 'text/plain');
  }

  console.log(
    `\nCopied ${pending.length - failures.filter((f) => !f.startsWith('show artwork')).length} episodes. Feed rebuild requested.`,
  );
  if (failures.length) {
    console.log(`${failures.length} failed (they still point at the old host; re-run to retry):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}
