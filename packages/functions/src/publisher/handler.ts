import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { EventBridgeEvent } from 'aws-lambda';
import { S3Store } from '../lib/store';
import type { PublisherDeps } from './feed';
import { rebuildAll, routeObjectCreated } from './route';

type S3ObjectCreated = EventBridgeEvent<
  'Object Created',
  { bucket: { name: string }; object: { key: string } }
>;
type Scheduled = EventBridgeEvent<'Scheduled Event', unknown>;

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
};

const cloudfront = new CloudFrontClient({});
const deps: PublisherDeps = {
  store: new S3Store(env('BUCKET_NAME')),
  baseUrl: env('PUBLIC_BASE_URL'),
  async invalidate(paths) {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: env('DISTRIBUTION_ID'),
        InvalidationBatch: {
          CallerReference: `${Date.now()}-${paths.join(',')}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
  },
  async notifyPodcastIndex(feedUrl) {
    const url = `https://api.podcastindex.org/api/1.0/hub/pubnotify?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DarkRelay/0.1' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  now: () => new Date(),
  log: (message, data) => console.log(JSON.stringify({ message, ...data })),
};

export async function handler(event: S3ObjectCreated | Scheduled) {
  if (event['detail-type'] === 'Scheduled Event') return rebuildAll(deps);
  return routeObjectCreated(deps, (event as S3ObjectCreated).detail.object.key);
}
