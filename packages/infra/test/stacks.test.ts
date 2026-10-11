import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeploymentConfig, type DeploymentConfigInput } from '../lib/config';
import { HostingStack } from '../lib/stacks/hosting-stack';
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
  });
  return { hosting: Template.fromStack(hosting), publish: Template.fromStack(publish) };
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
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 90 })] },
    });
  });
});

describe('access logs', () => {
  it('delivers CloudFront standard logs v2 to S3 as Parquet', () => {
    t.hosting.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ACCESS_LOGS' });
    t.hosting.hasResourceProperties('AWS::Logs::DeliveryDestination', { OutputFormat: 'parquet' });
    t.hosting.hasResourceProperties('AWS::Logs::Delivery', { S3EnableHiveCompatiblePath: true });
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
            key: [{ suffix: '/episode.json' }, { suffix: '/show.json' }, { suffix: '/rebuild' }],
          },
        }),
      }),
    });
    t.publish.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 hour)' });
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
