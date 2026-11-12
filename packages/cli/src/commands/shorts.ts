import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  ContentItem,
  SHORTS_MANIFEST_FILE,
  ShortsManifest,
  contentTypeFor,
  layout,
  newBundleId,
  outletsOfKind,
  publicationFor,
  type ContentItemInput,
} from '@darkrelay/core';
import { z } from 'zod';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { describeTime, parsePubDate } from '../dates';
import { loadBrand } from './brand';

const region = 'us-east-1';

export interface BatchPlan {
  /** Local path -> file name inside the batch. */
  files: { path: string; name: string }[];
  manifest: ShortsManifest;
}

/**
 * The files a batch has to carry: every video, and every thumbnail that
 * names one. The manifest goes up last, because its arrival is what starts
 * the ingest.
 */
export function planBatch(manifest: ShortsManifest, dir: string): BatchPlan {
  const names = new Set<string>();
  for (const short of manifest.shorts) {
    names.add(short.file);
    if (short.thumbnail) names.add(short.thumbnail);
  }
  const bad = [...names].filter((n) => n.includes('/') || n.startsWith('.'));
  if (bad.length) {
    throw new Error(
      `Batch files must sit next to ${SHORTS_MANIFEST_FILE}, named without a path: ${bad.join(', ')}`,
    );
  }
  return {
    manifest,
    files: [...names].map((name) => ({ path: join(dir, name), name })),
  };
}

async function readManifest(dir: string): Promise<ShortsManifest> {
  const path = join(dir, SHORTS_MANIFEST_FILE);
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(`No ${SHORTS_MANIFEST_FILE} in ${dir}`);
  });
  const parsed = ShortsManifest.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Uploads a batch of Shorts. The media and the manifest go to the inbox the
 * way an episode bundle does; a Lambda copies them into the brand's content
 * store and records each one. Nothing is sent to YouTube here: that happens
 * a few days before each slot.
 */
export async function putShorts(
  dir: string,
  flags: { brand?: string; show?: string; dryRun?: boolean; wait?: boolean },
  global: GlobalOptions,
) {
  const brandSlug = flags.brand ?? flags.show;
  if (!brandSlug) throw new Error('Pass --brand <slug>');
  const manifest = await readManifest(resolve(dir));
  const plan = planBatch(manifest, resolve(dir));
  for (const file of plan.files) {
    const info = await stat(file.path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${file.path} is not a file`);
  }

  const { bucket: name } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const brand = await loadBrand(bucket, brandSlug);
  if (!brand) throw new Error(`No brand or show "${brandSlug}" in this deployment`);
  const outlet = manifest.outlet ?? outletsOfKind(brand, 'youtube')[0]?.id;
  if (!outlet) {
    throw new Error(
      `${brandSlug} has no YouTube outlet. Add one: darkrelay brand outlet add ${brandSlug} --kind youtube --connection <name>`,
    );
  }

  console.log(`${manifest.shorts.length} ${manifest.kind}(s) for ${brandSlug} -> outlet ${outlet}`);
  for (const short of manifest.shorts) {
    const when = short.publishAt ? describeTime(new Date(short.publishAt)) : 'no slot yet';
    console.log(`  ${short.file.padEnd(28)} ${short.title}  (${when})`);
  }
  if (flags.dryRun) return console.log('\n--dry-run: nothing uploaded.');

  const batchId = newBundleId();
  const prefix = layout.inboxPrefix(brandSlug, batchId);
  for (const file of plan.files) {
    console.log(`Uploading ${basename(file.path)} -> ${file.name}`);
    await bucket.uploadFile(prefix + file.name, file.path, contentTypeFor(file.name));
  }
  // The manifest goes last: its arrival is what triggers the ingest.
  await bucket.putText(prefix + SHORTS_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  console.log(`Uploaded batch ${batchId}.`);

  if (flags.wait === false) return;
  const status = await waitForBatch(bucket, brandSlug, batchId);
  if (!status) {
    console.log(
      `Still ingesting. Check later with: darkrelay shorts batch ${brandSlug} ${batchId}`,
    );
    return;
  }
  reportBatch(status);
}

interface BatchStatus {
  status: string;
  items?: { id: string; title: string; publishAt?: string }[];
  errors?: string[];
  outlet?: string;
}

async function waitForBatch(bucket: Bucket, brand: string, batchId: string, tries = 20) {
  const key = layout.inboxStatus(brand, batchId);
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const raw = await bucket.getText(key);
    if (raw) return JSON.parse(raw) as BatchStatus;
  }
  return undefined;
}

function reportBatch(status: BatchStatus) {
  if (status.status !== 'ingested') {
    console.log('Batch rejected. Nothing was recorded:');
    for (const e of status.errors ?? []) console.log(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Recorded ${status.items?.length ?? 0} item(s) for outlet ${status.outlet}:`);
  for (const item of status.items ?? []) {
    const when = item.publishAt ? describeTime(new Date(item.publishAt)) : 'no slot yet';
    console.log(`  ${item.id.padEnd(32)} ${item.title}  (${when})`);
  }
  console.log('\nNothing is on YouTube yet: each uploads a few days before its slot.');
}

export async function batchStatus(brand: string, batchId: string, global: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const raw = await bucket.getText(layout.inboxStatus(brand, batchId));
  if (!raw) throw new Error(`No batch ${batchId} for ${brand} (results are kept 7 days)`);
  reportBatch(JSON.parse(raw) as BatchStatus);
}

export async function loadContent(bucket: Bucket, brand: string): Promise<ContentItem[]> {
  const items: ContentItem[] = [];
  for (const key of await bucket.list(layout.contentPrefix(brand))) {
    if (!key.endsWith('.json') || key.endsWith('.upload.json')) continue;
    const raw = await bucket.getText(key);
    if (!raw) continue;
    const parsed = ContentItem.safeParse(JSON.parse(raw));
    if (parsed.success) items.push(parsed.data);
  }
  return items.sort((a, b) => (a.publishAt ?? '~').localeCompare(b.publishAt ?? '~'));
}

/** Everything the brand has that is not an episode, and where each one stands. */
export async function listShorts(brand: string, global: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const items = await loadContent(bucket, brand);
  if (!items.length) {
    return console.log(`No videos or Shorts for ${brand}. Upload a batch: darkrelay shorts put`);
  }
  for (const item of items) {
    const publication = item.publications[0];
    const where = publication
      ? `${publication.state}${publication.externalId ? ` https://youtu.be/${publication.externalId}` : ''}`
      : 'no outlet';
    const when = item.publishAt ? describeTime(new Date(item.publishAt)) : 'no slot';
    console.log(`${item.id}`);
    console.log(`  ${item.kind.padEnd(6)} ${item.title}`);
    console.log(`  ${when}  ${where}`);
    if (publication?.error) console.log(`  error: ${publication.error}`);
    for (const w of publication?.warnings ?? []) console.log(`  warning: ${w}`);
  }
}

/**
 * Gives one item a slot, or moves it. A video already uploaded has its
 * release time moved on YouTube; one not uploaded yet goes up a few days
 * before the new slot.
 */
export async function scheduleShort(
  brand: string,
  id: string,
  flags: { at: string },
  global: GlobalOptions,
) {
  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  const key = layout.contentItem(brand, id);
  const raw = await bucket.getText(key);
  if (!raw) throw new Error(`No content "${id}" for ${brand}`);
  const item = ContentItem.parse(JSON.parse(raw));
  const at = parsePubDate(flags.at);

  const updated: ContentItemInput = {
    ...item,
    publishAt: at.toISOString(),
    publications: item.publications.map((p) =>
      p.state === 'published'
        ? p
        : { ...p, publishAt: at.toISOString(), updatedAt: new Date().toISOString() },
    ),
    updatedAt: new Date().toISOString(),
  };
  const parsed = ContentItem.parse(updated);
  await bucket.putText(key, JSON.stringify(parsed, null, 2));
  console.log(`${id} is scheduled for ${describeTime(at)}.`);

  const publication = publicationFor(parsed, parsed.publications[0]?.outlet ?? '');
  if (publication?.externalId) {
    await invokeShorts(global, { brand, id, outlet: publication.outlet });
    console.log('Moving its release time on YouTube now.');
  } else {
    console.log('It uploads a few days before that.');
  }
}

/** Uploads one item now, whatever its slot says. */
export async function uploadShortNow(
  brand: string,
  id: string,
  flags: { force?: boolean },
  global: GlobalOptions,
) {
  await invokeShorts(global, { brand, id, force: true, ...flags });
  console.log(`Upload started. Check it with: darkrelay shorts list ${brand}`);
}

/** Runs the sweep now instead of waiting for the hour. */
export async function sweepShorts(
  flags: { leadDays?: string; dailyUploads?: string },
  global: GlobalOptions,
) {
  const r = await invokeShorts(
    global,
    {
      sweep: true,
      leadDays: flags.leadDays ? Number(flags.leadDays) : undefined,
      dailyUploads: flags.dailyUploads ? Number(flags.dailyUploads) : undefined,
    },
    'RequestResponse',
  );
  console.log(r ?? 'Done.');
}

async function invokeShorts(
  g: GlobalOptions,
  event: Record<string, unknown>,
  type: 'Event' | 'RequestResponse' = 'Event',
) {
  const r = await new LambdaClient({ region }).send(
    new InvokeCommand({
      FunctionName: `${g.stackPrefix}-shorts`,
      InvocationType: type,
      Payload: new TextEncoder().encode(JSON.stringify(event)),
    }),
  );
  const body = new TextDecoder().decode(r.Payload ?? new Uint8Array());
  if (r.FunctionError) throw new Error(`The Shorts worker failed: ${body}`);
  return type === 'RequestResponse' ? body : undefined;
}
