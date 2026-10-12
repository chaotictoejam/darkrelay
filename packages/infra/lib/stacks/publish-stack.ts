import {
  Duration,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_scheduler as scheduler,
  aws_lambda_nodejs as nodejs,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { nodeFunction } from '../lambda';

export interface PublishStackProps extends StackProps {
  mediaBucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
  publicBaseUrl: string;
  stackPrefix: string;
}

/**
 * Publishing: an S3 upload of a bundle's episode.json (or a show.json change)
 * triggers one Lambda that writes manifests and rebuilds the feed. An hourly
 * sweep releases scheduled episodes. Off the download path entirely.
 */
export class PublishStack extends Stack {
  readonly publisher: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: PublishStackProps) {
    super(scope, id, props);

    // One-shot schedules, one per show, that rebuild the feed at the next release time.
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'Releases', {
      name: `${props.stackPrefix}-releases`,
    });
    const schedulerRole = new iam.Role(this, 'ReleaseSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });

    this.publisher = nodeFunction(this, 'Publisher', {
      entry: 'publisher/handler.ts',
      timeout: Duration.minutes(2),
      environment: {
        BUCKET_NAME: props.mediaBucket.bucketName,
        PUBLIC_BASE_URL: props.publicBaseUrl,
        DISTRIBUTION_ID: props.distribution.distributionId,
        SCHEDULE_GROUP: scheduleGroup.name!,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      },
    });
    this.publisher.grantInvoke(schedulerRole);
    this.publisher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
        ],
        resources: [
          this.formatArn({
            service: 'scheduler',
            resource: 'schedule',
            resourceName: `${scheduleGroup.name}/*`,
          }),
        ],
      }),
    );
    this.publisher.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRole.roleArn] }),
    );
    this.publisher.node.addDependency(scheduleGroup);
    props.mediaBucket.grantReadWrite(this.publisher);
    props.mediaBucket.grantDelete(this.publisher);
    props.distribution.grantCreateInvalidation(this.publisher);

    const target = new eventTargets.LambdaFunction(this.publisher, { retryAttempts: 2 });
    new events.Rule(this, 'OnUpload', {
      description: 'Bundle uploads, show config changes and rebuild requests',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.mediaBucket.bucketName] },
          object: {
            key: [
              ...events.Match.suffix('/episode.json'),
              ...events.Match.suffix('/show.json'),
              ...events.Match.suffix('/rebuild'),
            ],
          },
        },
      },
      targets: [target],
    });
    new events.Rule(this, 'Hourly', {
      description: 'Backstop for scheduled releases if a one-shot schedule is missed',
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [target],
    });
  }
}
