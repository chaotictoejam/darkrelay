import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import type { Context } from 'aws-lambda';
import type { EventBridgeEvent } from 'aws-lambda';
import { S3Store } from '../lib/store';
import { rebuildFeed, type PublisherDeps } from './feed';
import { onTranscoderStopped, rebuildAll, routeObjectCreated, type StoppedTask } from './route';

type S3ObjectCreated = EventBridgeEvent<
  'Object Created',
  { bucket: { name: string }; object: { key: string } }
>;
type Scheduled = EventBridgeEvent<'Scheduled Event', unknown>;
type TaskStopped = EventBridgeEvent<'ECS Task State Change', StoppedTask>;
/** Sent by the per-show one-shot schedule at the next release time. */
type Release = { release: string };

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
};

const cloudfront = new CloudFrontClient({});
const scheduler = new SchedulerClient({});
const ecs = new ECSClient({});
let selfArn = '';

/** Upserts the show's one-shot release schedule, or deletes it. */
async function scheduleRelease(show: string, at: Date | undefined) {
  const group = env('SCHEDULE_GROUP');
  if (!at) {
    await scheduler
      .send(new DeleteScheduleCommand({ Name: show, GroupName: group }))
      .catch((e: unknown) => {
        if (!(e instanceof ResourceNotFoundException)) throw e;
      });
    return;
  }
  const input: CreateScheduleCommandInput = {
    Name: show,
    GroupName: group,
    ScheduleExpression: `at(${at.toISOString().slice(0, 19)})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    ActionAfterCompletion: 'DELETE',
    Target: {
      Arn: selfArn,
      RoleArn: env('SCHEDULER_ROLE_ARN'),
      Input: JSON.stringify({ release: show } satisfies Release),
    },
  };
  try {
    await scheduler.send(new UpdateScheduleCommand(input));
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
    await scheduler.send(new CreateScheduleCommand(input));
  }
}
const deps: PublisherDeps = {
  store: new S3Store(env('BUCKET_NAME')),
  bucketName: env('BUCKET_NAME'),
  async startTranscode(job, opts = {}) {
    const r = await ecs.send(
      new RunTaskCommand({
        cluster: env('CLUSTER_ARN'),
        taskDefinition: env('TASK_DEFINITION_ARN'),
        count: 1,
        startedBy: 'darkrelay',
        capacityProviderStrategy: [
          { capacityProvider: opts.spot === false ? 'FARGATE' : 'FARGATE_SPOT', weight: 1 },
        ],
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: env('SUBNETS').split(','),
            securityGroups: [env('SECURITY_GROUP')],
            // Public subnet + public IP instead of a NAT gateway.
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: env('CONTAINER_NAME'),
              environment: [{ name: 'JOB', value: JSON.stringify(job) }],
            },
          ],
        },
      }),
    );
    if (r.failures?.length) throw new Error(`RunTask failed: ${JSON.stringify(r.failures)}`);
  },
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
  scheduleRelease,
  now: () => new Date(),
  log: (message, data) => console.log(JSON.stringify({ message, ...data })),
};

export async function handler(
  event: S3ObjectCreated | Scheduled | Release | TaskStopped,
  context: Context,
) {
  selfArn = context.invokedFunctionArn.split(':').slice(0, 7).join(':');
  if ('release' in event) return rebuildFeed(deps, event.release);
  if (event['detail-type'] === 'ECS Task State Change') {
    return onTranscoderStopped(deps, (event as TaskStopped).detail);
  }
  if (event['detail-type'] === 'Scheduled Event') return rebuildAll(deps);
  return routeObjectCreated(deps, (event as S3ObjectCreated).detail.object.key);
}
