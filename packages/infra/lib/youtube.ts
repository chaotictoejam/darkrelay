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
