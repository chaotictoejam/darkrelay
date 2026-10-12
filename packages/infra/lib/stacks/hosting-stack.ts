import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { ACCESS_LOG_FIELDS, ACCESS_LOG_PREFIX, ACCESS_LOG_SUFFIX } from '@darkrelay/core';
import type { Construct } from 'constructs';
import type { DeploymentConfig } from '../config';

export interface HostingStackProps extends StackProps {
  config: DeploymentConfig;
}

/**
 * The download path: S3 behind CloudFront and nothing else. No functions,
 * no database, so episodes keep downloading whatever happens to analytics.
 */
export class HostingStack extends Stack {
  readonly mediaBucket: s3.Bucket;
  readonly logBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly publicBaseUrl: string;

  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.mediaBucket = new s3.Bucket(this, 'Media', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      eventBridgeEnabled: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
        { prefix: 'inbox/', expiration: Duration.days(7) },
        { prefix: 'inbox-status/', expiration: Duration.days(30) },
      ],
    });

    this.logBucket = new s3.Bucket(this, 'Logs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      // Raw logs hold IP addresses; only aggregates are kept long term.
      lifecycleRules: [
        { expiration: Duration.days(config.logs.retentionDays) },
        { prefix: 'athena-results/', expiration: Duration.days(7) },
      ],
    });

    const domain = this.domain(config);

    const feedCachePolicy = new cloudfront.CachePolicy(this, 'FeedCache', {
      comment: 'RSS feeds: short TTL; publishes also invalidate',
      defaultTtl: Duration.minutes(5),
      maxTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket, {
      originPath: '/public',
    });
    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `${config.stackPrefix} media and feeds`,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // Web players fetch transcripts and chapters cross-origin.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
      additionalBehaviors: {
        '*/feed.xml': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: feedCachePolicy,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        },
      },
      domainNames: domain ? [domain.name] : undefined,
      certificate: domain?.certificate,
      priceClass: {
        '100': cloudfront.PriceClass.PRICE_CLASS_100,
        '200': cloudfront.PriceClass.PRICE_CLASS_200,
        All: cloudfront.PriceClass.PRICE_CLASS_ALL,
      }[config.priceClass],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    if (domain?.zone) {
      const target = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      );
      new route53.ARecord(this, 'AliasA', { zone: domain.zone, recordName: domain.name, target });
      new route53.AaaaRecord(this, 'AliasAAAA', {
        zone: domain.zone,
        recordName: domain.name,
        target,
      });
    }

    this.accessLogs(config);

    this.publicBaseUrl = `https://${domain?.name ?? this.distribution.distributionDomainName}`;
    new CfnOutput(this, 'MediaBucketName', { value: this.mediaBucket.bucketName });
    new CfnOutput(this, 'LogBucketName', { value: this.logBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'PublicBaseUrl', { value: this.publicBaseUrl });
  }

  private domain(config: DeploymentConfig) {
    const d = config.domain;
    if (!d) return undefined;
    if (d.dns === 'external') {
      return {
        name: d.name,
        zone: undefined,
        certificate: acm.Certificate.fromCertificateArn(this, 'Cert', d.certificateArn),
      };
    }
    const zone = d.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: d.hostedZoneId,
          zoneName: d.hostedZoneName,
        })
      : route53.HostedZone.fromLookup(this, 'Zone', { domainName: d.hostedZoneName });
    const certificate = new acm.Certificate(this, 'Cert', {
      domainName: d.name,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    return { name: d.name, zone, certificate };
  }

  /**
   * CloudFront standard logging (v2) to S3 as Parquet, partitioned by hour
   * (see ACCESS_LOG_PREFIX in core for the exact path). Billed as CloudWatch
   * vended logs: about $0.25/GB delivered plus about $0.035/GB for Parquet.
   * Cents per month at personal scale.
   */
  private accessLogs(config: DeploymentConfig) {
    const name = `${config.stackPrefix}-cdn-access`;
    // A prefix on the destination stops CloudFront adding AWSLogs/<account>/CloudFront/.
    const prefixArn = `${this.logBucket.bucketArn}/${ACCESS_LOG_PREFIX}`;
    this.logBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogDelivery',
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${prefixArn}/*`],
        conditions: {
          StringEquals: {
            's3:x-amz-acl': 'bucket-owner-full-control',
            'aws:SourceAccount': this.account,
          },
          ArnLike: {
            'aws:SourceArn': `arn:aws:logs:${this.region}:${this.account}:delivery-source:*`,
          },
        },
      }),
    );
    const source = new logs.CfnDeliverySource(this, 'AccessLogSource', {
      name,
      logType: 'ACCESS_LOGS',
      resourceArn: this.distribution.distributionArn,
    });
    const destination = new logs.CfnDeliveryDestination(this, 'AccessLogDestination', {
      name,
      destinationResourceArn: prefixArn,
      outputFormat: 'parquet',
    });
    destination.node.addDependency(this.logBucket.policy!);
    const delivery = new logs.CfnDelivery(this, 'AccessLogDelivery', {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
      recordFields: [...ACCESS_LOG_FIELDS],
      s3EnableHiveCompatiblePath: true,
      s3SuffixPath: ACCESS_LOG_SUFFIX,
    });
    delivery.addResourceDependency(source);
  }
}
