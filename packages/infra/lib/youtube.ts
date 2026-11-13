import {
  ArnFormat,
  Duration,
  Stack,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { ssmPrefix, type DeploymentConfig } from './config';
import { nodeFunction } from './lambda';

/** Read access to the OAuth secrets `darkrelay youtube connect` stores in SSM. */
function grantSecrets(fn: lambda.Function, config: DeploymentConfig) {
  const stack = Stack.of(fn);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        stack.formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: `${ssmPrefix(config).slice(1)}/*`,
        }),
      ],
    }),
  );
  // SecureStrings use the AWS-managed aws/ssm key; decrypt only via SSM.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
    }),
  );
}

/**
 * Uploads episode videos to YouTube. Triggered by every episode manifest
 * write; decides for itself whether there is anything to do. Uploads resume
 * across invocations, so file size isn't bound by the 15-minute limit.
 */
export function youtubeUploader(scope: Construct, config: DeploymentConfig, bucket: s3.IBucket) {
  const name = `${config.stackPrefix}-youtube-upload`;
  const fn = nodeFunction(scope, 'YouTubeUpload', {
    entry: 'youtube/upload-handler.ts',
    functionName: name,
    // Network throughput scales with memory; 1 GB also holds a 64 MB chunk easily.
    memorySize: 1024,
    timeout: Duration.minutes(15),
    environment: { BUCKET_NAME: bucket.bucketName, SSM_PREFIX: ssmPrefix(config) },
  });
  bucket.grantRead(fn, 'public/*');
  bucket.grantReadWrite(fn, 'catalog/*');
  grantSecrets(fn, config);
  // Hands off to itself; the ARN is built from the fixed name to avoid a dependency cycle.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        Stack.of(scope).formatArn({
          service: 'lambda',
          resource: 'function',
          resourceName: name,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }),
  );
  new events.Rule(scope, 'OnEpisodeManifest', {
    description: 'Episode manifest changed: upload to YouTube or resync its schedule',
    eventPattern: {
      source: ['aws.s3'],
      detailType: ['Object Created'],
      detail: {
        bucket: { name: [bucket.bucketName] },
        object: { key: events.Match.wildcard('catalog/*/episodes/*.json') },
      },
    },
    targets: [new eventTargets.LambdaFunction(fn, { retryAttempts: 2 })],
  });
  return fn;
}

/** Pulls YouTube Analytics nightly into the metrics table. */
export function youtubeAnalytics(
  scope: Construct,
  config: DeploymentConfig,
  bucket: s3.IBucket,
  table: dynamodb.ITable,
) {
  const fn = nodeFunction(scope, 'YouTubeAnalytics', {
    entry: 'youtube/analytics-handler.ts',
    timeout: Duration.minutes(10),
    environment: {
      MEDIA_BUCKET: bucket.bucketName,
      TABLE_NAME: table.tableName,
      SSM_PREFIX: ssmPrefix(config),
    },
  });
  bucket.grantRead(fn, 'catalog/*');
  table.grantReadWriteData(fn);
  grantSecrets(fn, config);
  new events.Rule(scope, 'YouTubeNightly', {
    description: 'Pull YouTube views, watch time and retention',
    schedule: events.Schedule.cron({ minute: '40', hour: '4' }),
    targets: [new eventTargets.LambdaFunction(fn, { retryAttempts: 2 })],
  });
  return fn;
}

/**
 * Shorts and other non-episode content: ingests a batch manifest when it
 * lands in the inbox, and every hour uploads whatever is due in the next few
 * days as a private video with a publishAt.
 *
 * Uploading days ahead is what makes an hourly pass precise enough, and the
 * daily cap is what keeps a quarter's worth of Shorts from going up at once:
 * a YouTube upload costs 1,600 of the default 10,000 daily quota units.
 */
export function shortsScheduler(scope: Construct, config: DeploymentConfig, bucket: s3.IBucket) {
  const name = `${config.stackPrefix}-shorts`;
  const fn = nodeFunction(scope, 'Shorts', {
    entry: 'shorts/handler.ts',
    functionName: name,
    memorySize: 1024,
    timeout: Duration.minutes(15),
    environment: {
      BUCKET_NAME: bucket.bucketName,
      SSM_PREFIX: ssmPrefix(config),
      LEAD_DAYS: String(config.shorts.leadDays),
      DAILY_UPLOADS: String(config.shorts.dailyUploads),
    },
  });
  bucket.grantRead(fn, 'inbox/*');
  bucket.grantReadWrite(fn, 'catalog/*');
  bucket.grantWrite(fn, 'inbox-status/*');
  grantSecrets(fn, config);
  // Hands off to itself; the ARN is built from the fixed name to avoid a cycle.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        Stack.of(scope).formatArn({
          service: 'lambda',
          resource: 'function',
          resourceName: name,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }),
  );
  new events.Rule(scope, 'OnShortsBatch', {
    description: 'A batch of Shorts was uploaded: ingest it',
    eventPattern: {
      source: ['aws.s3'],
      detailType: ['Object Created'],
      detail: {
        bucket: { name: [bucket.bucketName] },
        object: { key: events.Match.wildcard('inbox/*/*/shorts.json') },
      },
    },
    targets: [new eventTargets.LambdaFunction(fn, { retryAttempts: 2 })],
  });
  new events.Rule(scope, 'ShortsSweep', {
    description: 'Upload Shorts whose slot is close, and move any that were rescheduled',
    schedule: events.Schedule.rate(Duration.hours(1)),
    targets: [new eventTargets.LambdaFunction(fn, { retryAttempts: 2 })],
  });
  return fn;
}

/**
 * Slot scoring and planning, on demand. It reads the metrics table and the
 * catalog and writes plans; it has no schedule, no YouTube credentials and
 * no way to upload anything, which is what keeps a planning mistake from
 * becoming a published video.
 */
export function shortsPlanner(
  scope: Construct,
  config: DeploymentConfig,
  bucket: s3.IBucket,
  table: dynamodb.ITable,
) {
  const fn = nodeFunction(scope, 'ShortsPlan', {
    entry: 'shorts/plan-handler.ts',
    functionName: `${config.stackPrefix}-shorts-plan`,
    timeout: Duration.minutes(5),
    environment: {
      MEDIA_BUCKET: bucket.bucketName,
      TABLE_NAME: table.tableName,
      TIMEZONE: config.shorts.timezone,
      PER_WEEK: String(config.shorts.perWeek),
      LEAD_DAYS: String(config.shorts.leadDays),
    },
  });
  table.grantReadData(fn);
  bucket.grantRead(fn, 'catalog/*');
  // Plans are written next to the content they schedule; approving a plan
  // puts the times on the content records, and nothing else.
  bucket.grantWrite(fn, 'catalog/*');
  return fn;
}
