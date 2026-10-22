import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_events as events,
  aws_iam as iam,
  aws_events_targets as eventTargets,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  Duration,
} from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import type { DeploymentConfig } from './config';
import { REPO_ROOT } from './lambda';

export const CONTAINER_NAME = 'transcoder';

export interface TranscoderProps {
  config: DeploymentConfig;
  bucket: s3.IBucket;
  /** Gets RunTask rights, the env it needs, and the task-stopped events. */
  publisher: lambda.Function;
}

/**
 * ffmpeg on Fargate Spot, started per upload by the publisher. Public
 * subnets with a public IP instead of a NAT gateway; S3 traffic goes
 * through a free gateway endpoint. Nothing runs between jobs.
 */
export class Transcoder extends Construct {
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: TranscoderProps) {
    super(scope, id);
    const { config, bucket, publisher } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: config.transcoder.availabilityZones,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });
    const securityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'Transcoder tasks: outbound only',
      allowAllOutbound: true,
    });

    this.cluster = new ecs.Cluster(this, 'Cluster', { vpc, enableFargateCapacityProviders: true });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: config.transcoder.cpu,
      memoryLimitMiB: config.transcoder.memoryMiB,
      ephemeralStorageGiB: config.transcoder.ephemeralGiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    this.taskDefinition.addContainer(CONTAINER_NAME, {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: 'packages/transcoder/Dockerfile',
        platform: Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'transcoder',
        logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH }),
      }),
      stopTimeout: Duration.seconds(30),
    });
    // Reads the upload, writes extracted audio + processed.json back, and HLS to public/.
    bucket.grantRead(this.taskDefinition.taskRole, 'inbox/*');
    bucket.grantPut(this.taskDefinition.taskRole, 'inbox/*');
    bucket.grantPut(this.taskDefinition.taskRole, 'public/*');

    this.taskDefinition.grantRun(publisher);
    // RunTask copies the task definition's cost tags onto each task, which needs TagResource.
    publisher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:TagResource'],
        resources: ['*'],
        conditions: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
      }),
    );
    const env: Record<string, string> = {
      CLUSTER_ARN: this.cluster.clusterArn,
      TASK_DEFINITION_ARN: this.taskDefinition.taskDefinitionArn,
      SUBNETS: vpc.publicSubnets.map((s) => s.subnetId).join(','),
      SECURITY_GROUP: securityGroup.securityGroupId,
      CONTAINER_NAME,
    };
    for (const [k, v] of Object.entries(env)) publisher.addEnvironment(k, v);

    // A task that stops without writing processed.json (Spot interruption,
    // crash) is retried once on regular Fargate by the publisher.
    new events.Rule(this, 'Stopped', {
      description: 'Transcoder task stopped',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: { clusterArn: [this.cluster.clusterArn], lastStatus: ['STOPPED'] },
      },
      targets: [new eventTargets.LambdaFunction(publisher, { retryAttempts: 2 })],
    });
  }
}
