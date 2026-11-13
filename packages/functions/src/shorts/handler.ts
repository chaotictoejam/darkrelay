import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { EpisodeManifest, SHORTS_MANIFEST_FILE, layout } from '@darkrelay/core';
import type { Context, EventBridgeEvent } from 'aws-lambda';
import { listBrands, loadBrand } from '../lib/brands';
import { S3Store } from '../lib/store';
import { loadShow } from '../publisher/feed';
import { youtubeConnections } from '../youtube/connections';
import { ingestBatch } from './ingest';
import { sweepDue, uploadContent, type ShortsUploadDeps, type UploadEvent } from './upload';

type ObjectCreated = EventBridgeEvent<'Object Created', { object: { key: string } }>;
type Scheduled = EventBridgeEvent<'Scheduled Event', unknown>;
type Sweep = { sweep: true; leadDays?: number; dailyUploads?: number };

const BATCH = new RegExp(
  `^inbox/([a-z0-9][a-z0-9-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/${SHORTS_MANIFEST_FILE}$`,
);

const lambda = new LambdaClient({});
const store = new S3Store(process.env['BUCKET_NAME']!);
const youtubeFor = youtubeConnections(process.env['SSM_PREFIX']!);
const log = (message: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ message, ...data }));

const number = (name: string) => {
  const v = process.env[name];
  return v ? Number(v) : undefined;
};

function uploadDeps(context: Context): ShortsUploadDeps {
  return {
    store,
    brands: () => listBrands(store, log),
    loadShow: (show) => loadShow(store, show),
    youtubeFor,
    async continueLater(next) {
      await lambda.send(
        new InvokeCommand({
          FunctionName: context.functionName,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify(next)),
        }),
      );
    },
    timeLeftMs: () => context.getRemainingTimeInMillis(),
    now: () => new Date(),
    log,
  };
}

/**
 * Three ways in: a batch manifest landing in the inbox, the hourly sweep,
 * and a direct invoke to upload one item (the CLI, and the hand-off a long
 * upload makes to itself).
 */
export async function handler(
  event: ObjectCreated | Scheduled | Sweep | UploadEvent,
  context: Context,
) {
  if ('detail' in event && event['detail-type'] === 'Object Created') {
    const m = BATCH.exec((event as ObjectCreated).detail.object.key);
    if (!m) return 'ignored';
    return ingestBatch(
      {
        store,
        loadBrand: (brand) => loadBrand(store, brand, log),
        async episodeGuids(brand) {
          const keys = (await store.list(layout.episodesPrefix(brand)))
            .map((o) => o.key)
            .filter((k) => k.endsWith('.json'));
          const guids: string[] = [];
          for (const key of keys) {
            const raw = await store.getText(key);
            if (!raw) continue;
            const parsed = EpisodeManifest.safeParse(JSON.parse(raw));
            if (parsed.success) guids.push(parsed.data.guid);
          }
          return guids;
        },
        now: () => new Date(),
        log,
      },
      m[1]!,
      m[2]!,
    );
  }

  if ('detail-type' in event || 'sweep' in event) {
    const opts: Partial<Sweep> = 'sweep' in event ? event : {};
    return sweepDue(uploadDeps(context), {
      leadDays: opts.leadDays ?? number('LEAD_DAYS'),
      dailyUploads: opts.dailyUploads ?? number('DAILY_UPLOADS'),
    });
  }

  return uploadContent(uploadDeps(context), event);
}
