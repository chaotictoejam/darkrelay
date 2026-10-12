import { AthenaClient } from '@aws-sdk/client-athena';
import { EpisodeManifest, ShowConfig, layout, metricKeys, type MetricItem } from '@darkrelay/core';
import { S3Store } from '../lib/store';
import { aggregateDay, defaultDates, type AggregateDeps } from './aggregate';
import { runQuery } from './athena';
import { putAll, queryAll } from './dynamo';
import { dailyQuery } from './query';

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
};

const athena = new AthenaClient({});
const media = new S3Store(env('MEDIA_BUCKET'));
const table = env('TABLE_NAME');
const target = {
  database: env('GLUE_DATABASE'),
  table: env('GLUE_TABLE'),
  distributionId: env('DISTRIBUTION_ID'),
};

const deps: AggregateDeps = {
  async queryDay(date) {
    const { rows, stats } = await runQuery(athena, dailyQuery(target, date), env('WORKGROUP'));
    return { rows, bytesScanned: stats.bytesScanned };
  },
  async loadManifest(show, episodeId) {
    const raw = await media.getText(layout.episodeManifest(show, episodeId));
    return raw ? EpisodeManifest.parse(JSON.parse(raw)) : undefined;
  },
  async loadShowTitle(show) {
    const raw = await media.getText(layout.showConfig(show));
    return raw ? ShowConfig.parse(JSON.parse(raw)).title : undefined;
  },
  put: (items) => putAll(table, items),
  episodeSeries: (show, episodeId) =>
    queryAll<MetricItem>({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': metricKeys.episodeSeries(show, episodeId) },
    }),
  now: () => new Date(),
  log: (message, data) => console.log(JSON.stringify({ message, ...data })),
};

/** Scheduled nightly; can also be invoked with {"dates": ["2026-10-11"]} to backfill. */
export async function handler(event: { dates?: string[] } = {}) {
  const dates = event.dates?.length ? event.dates : defaultDates(new Date());
  const results = [];
  for (const date of dates) results.push(await aggregateDay(deps, date));
  return results;
}
