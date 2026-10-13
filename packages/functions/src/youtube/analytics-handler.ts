import { EpisodeManifest, ShowConfig, layout, metricKeys, type MetricItem } from '@darkrelay/core';
import { putAll, queryAll } from '../analytics/dynamo';
import { S3Store } from '../lib/store';
import { youtubeConnections } from './connections';
import { defaultRange, pullYouTube, type Range } from './analytics';

const store = new S3Store(process.env['MEDIA_BUCKET']!);
const table = process.env['TABLE_NAME']!;
const youtubeFor = youtubeConnections(process.env['SSM_PREFIX']!);

const SHOW = /^catalog\/([a-z0-9][a-z0-9-]*)\/show\.json$/;

/** Nightly, or invoked with {"from":"2026-09-01","to":"2026-10-11"} to backfill. */
export async function handler(event: Partial<Range> = {}) {
  const range =
    event.from && event.to ? { from: event.from, to: event.to } : defaultRange(new Date());
  return pullYouTube(
    {
      async shows() {
        const keys = (await store.list('catalog/')).map((o) => o.key).filter((k) => SHOW.test(k));
        return Promise.all(
          keys.map(async (k) => ShowConfig.parse(JSON.parse((await store.getText(k))!))),
        );
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
      episodeSeries: (show, id) =>
        queryAll<MetricItem>({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': metricKeys.episodeSeries(show, id) },
        }),
      now: () => new Date(),
      log: (message, data) => console.log(JSON.stringify({ message, ...data })),
    },
    range,
  );
}
