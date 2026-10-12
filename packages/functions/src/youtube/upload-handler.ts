import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Context, EventBridgeEvent } from 'aws-lambda';
import { S3Store } from '../lib/store';
import { youtubeConnections } from './connections';
import { onEpisodeChanged, type UploadEvent } from './upload';

type ManifestWritten = EventBridgeEvent<'Object Created', { object: { key: string } }>;

const MANIFEST = /^catalog\/([a-z0-9][a-z0-9-]*)\/episodes\/([0-9a-f]{16})\.json$/;
const lambda = new LambdaClient({});
const store = new S3Store(process.env['BUCKET_NAME']!);
const youtubeFor = youtubeConnections(process.env['SSM_PREFIX']!);

/** Triggered by every episode manifest write, or invoked directly (CLI, hand-offs). */
export async function handler(event: ManifestWritten | UploadEvent, context: Context) {
  let job: UploadEvent;
  if ('detail' in event) {
    const m = MANIFEST.exec(event.detail.object.key);
    if (!m) return 'ignored';
    job = { show: m[1]!, episodeId: m[2]! };
  } else {
    job = event;
  }
  return onEpisodeChanged(
    {
      store,
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
      log: (message, data) => console.log(JSON.stringify({ message, ...data })),
    },
    job,
  );
}
