import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeploymentConfig, type DeploymentConfigInput } from '../lib/config';
import { HostingStack } from '../lib/stacks/hosting-stack';
import { AlertsStack } from '../lib/stacks/alerts-stack';
import { AnalyticsStack } from '../lib/stacks/analytics-stack';
import { DashboardStack } from '../lib/stacks/dashboard-stack';
import { PublishStack } from '../lib/stacks/publish-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(input: DeploymentConfigInput) {
  const config = DeploymentConfig.parse(input);
  const app = new App();
  const hosting = new HostingStack(app, 'Hosting', { env, config });
  const publish = new PublishStack(app, 'Publish', {
    env,
    mediaBucket: hosting.mediaBucket,
    distribution: hosting.distribution,
    publicBaseUrl: hosting.publicBaseUrl,
    config,
  });
  const analytics = new AnalyticsStack(app, 'Analytics', {
    env,
    config,
    logBucket: hosting.logBucket,
    mediaBucket: hosting.mediaBucket,
    distribution: hosting.distribution,
  });
  const dashboard = new DashboardStack(app, 'Dashboard', {
    env,
    config,
    table: analytics.table,
    mediaBucket: hosting.mediaBucket,
  });
  return {
    hosting: Template.fromStack(hosting),
    publish: Template.fromStack(publish),
    analytics: Template.fromStack(analytics),
    dashboard: Template.fromStack(dashboard),
  };
}

let t: ReturnType<typeof synth>;
beforeAll(() => {
  t = synth({
    domain: {
      dns: 'route53',
      name: 'media.example.com',
      hostedZoneName: 'example.com',
      hostedZoneId: 'Z123',
    },
  });
}, 120_000);

describe('fail-open download path', () => {
  it('serves from S3 only, with no functions on any behavior', () => {
    const dist = Object.values(t.hosting.findResources('AWS::CloudFront::Distribution'))[0]!;
    const cfg = dist['Properties'].DistributionConfig;
    expect(cfg.Origins).toHaveLength(1);
    expect(cfg.Origins[0].S3OriginConfig).toBeDefined();
    expect(cfg.Origins[0].OriginPath).toBe('/public');
    for (const b of [cfg.DefaultCacheBehavior, ...(cfg.CacheBehaviors ?? [])]) {
      expect(b.FunctionAssociations).toBeUndefined();
      expect(b.LambdaFunctionAssociations).toBeUndefined();
    }
  });

  it('has no Lambda, DynamoDB or VPC resources in the hosting stack besides deploy-time helpers', () => {
    expect(t.hosting.findResources('AWS::DynamoDB::Table')).toEqual({});
    expect(t.hosting.findResources('AWS::EC2::NatGateway')).toEqual({});
    expect(t.hosting.findResources('AWS::EC2::VPC')).toEqual({});
  });

  it('caches feeds for 5 minutes and media with the optimized policy', () => {
    t.hosting.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ DefaultTTL: 300, MaxTTL: 300 }),
    });
    t.hosting.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['media.example.com'],
        CacheBehaviors: [Match.objectLike({ PathPattern: '*/feed.xml' })],
      }),
    });
  });
});

describe('storage', () => {
  it('keeps both buckets private and retained', () => {
    const buckets = t.hosting.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const b of Object.values(buckets)) {
      expect(b['DeletionPolicy']).toBe('Retain');
      expect(b['Properties'].PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('expires raw access logs after the configured retention', () => {
    t.hosting.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({ ExpirationInDays: 90 }),
          Match.objectLike({ Prefix: 'athena-results/', ExpirationInDays: 7 }),
        ],
      },
    });
  });
});

describe('access logs', () => {
  it('delivers CloudFront standard logs v2 to S3 as Parquet', () => {
    t.hosting.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ACCESS_LOGS' });
    t.hosting.hasResourceProperties('AWS::Logs::DeliveryDestination', { OutputFormat: 'parquet' });
    t.hosting.hasResourceProperties('AWS::Logs::Delivery', {
      S3EnableHiveCompatiblePath: true,
      S3SuffixPath: '{distributionid}/{yyyy}/{MM}/{dd}/{HH}',
      RecordFields: Match.arrayWith(['c-ip', 'cs(User-Agent)', 'sc-range-start', 'c-country']),
    });
    // A prefix on the destination keeps CloudFront from inserting AWSLogs/<account>/CloudFront/.
    t.hosting.hasResourceProperties('AWS::Logs::DeliveryDestination', {
      DestinationResourceArn: { 'Fn::Join': ['', [Match.anyValue(), '/cloudfront']] },
    });
  });
});

describe('domain', () => {
  it('creates a DNS-validated certificate and alias records for Route 53', () => {
    t.hosting.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'media.example.com',
      ValidationMethod: 'DNS',
    });
    t.hosting.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  it('uses a provided certificate and creates no records for external DNS', () => {
    const ext = synth({
      domain: {
        dns: 'external',
        name: 'media.example.com',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      },
    });
    ext.hosting.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    ext.hosting.resourceCountIs('AWS::Route53::RecordSet', 0);
  }, 120_000);
});

describe('publisher', () => {
  it('runs on Node 22 arm64 with the bucket, base URL and distribution', () => {
    t.publish.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({ PUBLIC_BASE_URL: 'https://media.example.com' }),
      },
    });
  });

  it('is triggered by bundle, show config and rebuild uploads, and hourly', () => {
    t.publish.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        'detail-type': ['Object Created'],
        detail: Match.objectLike({
          object: {
            key: [
              { suffix: '/episode.json' },
              { suffix: '/processed.json' },
              { suffix: '/show.json' },
              { suffix: '/rebuild' },
            ],
          },
        }),
      }),
    });
    t.publish.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 hour)' });
  });
});

describe('transcoder', () => {
  it('uses public subnets with no NAT gateway and a free S3 gateway endpoint', () => {
    t.publish.resourceCountIs('AWS::EC2::NatGateway', 0);
    const subnets = Object.values(t.publish.findResources('AWS::EC2::Subnet'));
    expect(subnets.length).toBe(2);
    for (const sn of subnets) expect(sn['Properties'].MapPublicIpOnLaunch).toBe(true);
    t.publish.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
    t.publish.resourceCountIs('AWS::EC2::VPCEndpoint', 1); // no paid interface endpoints
  });

  it('runs on Fargate Spot with the configured size and scratch disk', () => {
    t.publish.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
      CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    });
    t.publish.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '8192',
      EphemeralStorage: { SizeInGiB: 60 },
      RequiresCompatibilities: ['FARGATE'],
    });
  });

  it('lets the task read uploads and write outputs, but not delete', () => {
    const policies = JSON.stringify(t.publish.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('ecs:RunTask');
    const taskPolicies = Object.entries(t.publish.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('TranscoderTaskTaskRole'))
      .map(([, p]) => JSON.stringify(p));
    expect(taskPolicies).toHaveLength(1);
    expect(taskPolicies[0]).toContain('s3:PutObject');
    expect(taskPolicies[0]).not.toContain('s3:DeleteObject');
  });

  it('sends stopped tasks back to the publisher and gives it the RunTask settings', () => {
    t.publish.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.ecs'],
        detail: Match.objectLike({ lastStatus: ['STOPPED'] }),
      }),
    });
    t.publish.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONTAINER_NAME: 'transcoder',
          SUBNETS: Match.anyValue(),
          SECURITY_GROUP: Match.anyValue(),
        }),
      },
    });
  });
});

describe('youtube', () => {
  it('runs the uploader on every episode manifest write, for up to 15 minutes', () => {
    t.publish.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        detail: Match.objectLike({ object: { key: [{ wildcard: 'catalog/*/episodes/*.json' }] } }),
      }),
    });
    t.publish.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DarkRelay-youtube-upload',
      Timeout: 900,
      MemorySize: 1024,
      Environment: { Variables: Match.objectLike({ SSM_PREFIX: '/darkrelay' }) },
    });
  });

  it('lets the uploader hand off to itself and read only its own secrets', () => {
    const policies = JSON.stringify(t.publish.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(':function:DarkRelay-youtube-upload');
    expect(policies).toContain(':parameter/darkrelay/*');
    expect(policies).toContain('ssm.us-east-1.amazonaws.com');
  });

  it('pulls YouTube Analytics nightly after the CloudFront count', () => {
    t.analytics.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(40 4 * * ? *)',
    });
    t.analytics.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ SSM_PREFIX: '/darkrelay', TABLE_NAME: Match.anyValue() }),
      },
    });
  });
});

describe('scheduled releases', () => {
  it('lets the publisher manage only its own schedule group, and the scheduler invoke only the publisher', () => {
    t.publish.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Name: 'DarkRelay-releases',
    });
    const policies = JSON.stringify(t.publish.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(':schedule/DarkRelay-releases/*');
    expect(policies).toContain('iam:PassRole');
    expect(policies).not.toMatch(/"scheduler:\*"|schedule\/\*"/);
    t.publish.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })],
      },
    });
    t.publish.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ SCHEDULE_GROUP: 'DarkRelay-releases' }) },
    });
  });
});

describe('analytics', () => {
  it('projects partitions on the exact path CloudFront writes', () => {
    t.analytics.hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({
        Parameters: Match.objectLike({
          'projection.enabled': 'true',
          'projection.hour.range': '0,23',
          'storage.location.template': {
            'Fn::Join': [
              '',
              [
                's3://',
                Match.anyValue(),
                '/cloudfront/distributionid=${distributionid}/year=${year}/month=${month}/day=${day}/hour=${hour}',
              ],
            ],
          },
        }),
        StorageDescriptor: Match.objectLike({
          Columns: Match.arrayWith([
            { Name: 'c_ip', Type: 'string' },
            { Name: 'cs_user_agent', Type: 'string' },
            { Name: 'c_country', Type: 'string' },
          ]),
        }),
      }),
    });
  });

  it('caps Athena scans and runs nightly', () => {
    t.analytics.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: Match.objectLike({
        BytesScannedCutoffPerQuery: 1_000_000_000,
        EnforceWorkGroupConfiguration: true,
      }),
    });
    t.analytics.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(20 3 * * ? *)',
    });
  });

  it('stores aggregates in on-demand DynamoDB', () => {
    t.analytics.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });
});

describe('dashboard', () => {
  it('never lets the dashboard API touch Athena or Glue', () => {
    const policies = JSON.stringify(t.dashboard.findResources('AWS::IAM::Policy'));
    expect(policies).not.toMatch(/athena:|glue:/);
    expect(policies).toMatch(/dynamodb:Query/);
    expect(policies).not.toMatch(/dynamodb:PutItem|dynamodb:BatchWriteItem/);
  });

  it('requires Cognito sign-in on every route, with no self sign-up', () => {
    t.dashboard.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UserPoolTier: 'LITE',
    });
    const routes = Object.values(t.dashboard.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.map((r) => r['Properties'].RouteKey).sort()).toEqual([
      'GET /me',
      'GET /shows',
      'GET /shows/{proxy+}',
      'GET /shows/{show}/uploads/{bundleId}',
      'POST /shows/{show}/uploads',
      'POST /shows/{show}/uploads/{bundleId}/{action}',
    ]);
    for (const r of routes) expect(r['Properties'].AuthorizationType).toBe('JWT');
  });

  it('creates the admin group; per-show groups come from the CLI', () => {
    t.dashboard.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
    t.dashboard.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admin' });
  });

  it('lets the upload function write only under inbox/, and never delete', () => {
    const fn = Object.entries(t.dashboard.findResources('AWS::Lambda::Function')).find(([id]) =>
      id.startsWith('Uploads'),
    );
    expect(fn).toBeDefined();
    const policies = Object.values(t.dashboard.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p['Properties'].Roles).includes('UploadsServiceRole'),
    );
    const statements = policies.flatMap(
      (p) => p['Properties'].PolicyDocument.Statement as Record<string, unknown>[],
    );
    const writes = statements.filter((st) => JSON.stringify(st['Action']).includes('s3:PutObject'));
    expect(writes.length).toBeGreaterThan(0);
    for (const st of writes) expect(JSON.stringify(st['Resource'])).toMatch(/\/inbox\/\*"/);
    const all = JSON.stringify(statements);
    expect(all).not.toMatch(/s3:DeleteObject|dynamodb:/);
    for (const st of statements.filter((st) =>
      JSON.stringify(st['Action']).includes('GetObject'),
    )) {
      expect(JSON.stringify(st['Resource'])).toMatch(
        /\/(inbox\/\*|inbox-status\/\*|catalog\/\*\/show\.json)"/,
      );
    }
  });

  it('allows browser PUTs to the media bucket from the dashboard only, exposing ETag', () => {
    const [cors] = Object.values(t.dashboard.findResources('Custom::AWS'));
    const create = JSON.stringify(cors!['Properties'].Create);
    expect(create).toMatch(/putBucketCors/);
    expect(create).toMatch(/\\"AllowedMethods\\":\[\\"PUT\\"\]/);
    expect(create).toMatch(/ETag/);
    expect(create).toMatch(/localhost:5173/);
    expect(create).not.toMatch(/\\"\*\\"/);
  });

  it('allows POST from the dashboard to the API', () => {
    t.dashboard.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowMethods: ['GET', 'POST'],
        AllowHeaders: ['authorization', 'content-type'],
      }),
    });
  });
});

describe('alerts', () => {
  function alerts(input: DeploymentConfigInput['alerts']) {
    const config = DeploymentConfig.parse({ alerts: input });
    const app = new App();
    const hosting = new HostingStack(app, 'H', { env, config });
    return Template.fromStack(
      new AlertsStack(app, 'A', {
        env,
        config,
        alerts: config.alerts!,
        distribution: hosting.distribution,
      }),
    );
  }

  it('alarms on bytes served per hour by this distribution only', () => {
    const a = alerts({ email: 'me@example.com' });
    a.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/CloudFront',
      MetricName: 'BytesDownloaded',
      Statistic: 'Sum',
      Period: 3600,
      Threshold: 20 * 1024 ** 3,
      Dimensions: Match.arrayWith([{ Name: 'Region', Value: 'Global' }]),
    });
    a.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'me@example.com',
    });
  });

  it('budgets CloudFront spend with an email at each threshold plus a forecast, and no actions', () => {
    const a = alerts({ email: 'me@example.com', monthlyUsd: [100, 25] });
    a.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 100, Unit: 'USD' },
        CostFilters: { Service: ['Amazon CloudFront'] },
      }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 25 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 100 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 25 }),
        }),
      ],
    });
    // Budget actions are what AWS charges for; this budget has none.
    a.resourceCountIs('AWS::Budgets::BudgetsAction', 0);
  });

  it('rejects more thresholds than a budget can notify on', () => {
    expect(() =>
      DeploymentConfig.parse({ alerts: { email: 'me@example.com', monthlyUsd: [1, 2, 3, 4, 5] } }),
    ).toThrow();
  });
});

describe('config', () => {
  it('rejects a certificate outside us-east-1', () => {
    expect(() =>
      DeploymentConfig.parse({
        domain: {
          dns: 'external',
          name: 'm.example.com',
          certificateArn: 'arn:aws:acm:eu-west-1:1:certificate/x',
        },
      }),
    ).toThrow();
  });
});
