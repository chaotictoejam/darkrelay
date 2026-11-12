import { EpisodeManifest, layout, type MetricItem } from '@darkrelay/core';
import { putAll, queryAll } from '../analytics/dynamo';
import { listBrands } from '../lib/brands';
import { S3Store } from '../lib/store';
import { youtubeConnections } from './connections';
import { defaultRange, pullYouTube, type PullOptions, type Range } from './analytics';

const store = new S3Store(process.env['MEDIA_BUCKET']!);
const table = process.env['TABLE_NAME']!;
const youtubeFor = youtubeConnections(process.env['SSM_PREFIX']!);

const log = (message: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ message, ...data }));

/**
 * Nightly, or invoked with {"from":"2026-09-01","to":"2026-10-11"} to
 * backfill. `{"listUploads":true}` also records videos with no views in the
 * range, which is what a first backfill of a channel needs, and `brand`
 * narrows a backfill to one brand.
 */
export async function handler(event: Partial<Range> & PullOptions & { brand?: string } = {}) {
  const range =
    event.from && event.to ? { from: event.from, to: event.to } : defaultRange(new Date());
  return pullYouTube(
    {
      async brands() {
        const brands = await listBrands(store, log);
        return event.brand ? brands.filter((b) => b.slug === event.brand) : brands;
      },
      async episodes(show) {
        const keys = (await store.list(layout.episodesPrefix(show)))
          .map((o) => o.key)
          .filter((k) => k.endsWith('.json'));
        return Promise.all(
          keys.map(async (k) => EpisodeManifest.parse(JSON.parse((await store.getText(k))!))),
        );
      },
      youtubeFor,
      put: (items) => putAll(table, items),
      series: (pk) =>
        queryAll<MetricItem>({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
        }),
      now: () => new Date(),
      log,
    },
    range,
    { listUploads: event.listUploads },
  );
}
