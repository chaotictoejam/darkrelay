import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  custom_resources as cr,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { ADMIN_GROUP } from '@darkrelay/core';
import type { DeploymentConfig } from '../config';
import { REPO_ROOT, nodeFunction } from '../lambda';

export interface DashboardStackProps extends StackProps {
  config: DeploymentConfig;
  table: dynamodb.ITable;
  mediaBucket: s3.IBucket;
}

const DIST = resolve(REPO_ROOT, 'packages/dashboard/dist');

/**
 * The dashboard: a static site, Cognito sign-in (no self sign-up), and an
 * HTTP API. One Lambda reads pre-aggregated DynamoDB items only; another
 * hands uploaders presigned URLs into the media bucket's inbox, so episode
 * bytes go straight from the browser to S3. Cognito groups decide who sees
 * and uploads what: `admin`, or `viewer:<show>` / `uploader:<show>`.
 */
export class DashboardStack extends Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);
    const { config, table, mediaBucket } = props;

    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, 'SiteCdn', {
      comment: `${config.stackPrefix} dashboard`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;

    const userPool = new cognito.UserPool(this, 'Users', {
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12 },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const domain = userPool.addDomain('Login', {
      cognitoDomain: { domainPrefix: `${config.stackPrefix.toLowerCase()}-${this.account}` },
    });
    const client = userPool.addClient('Dashboard', {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${siteUrl}/`, 'http://localhost:5173/'],
        logoutUrls: [`${siteUrl}/`, 'http://localhost:5173/'],
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });
    // Per-show groups are created by the CLI when someone is first given a role for that show.
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: 'Every show: analytics and uploads',
    });

    const reader = nodeFunction(this, 'Api', {
      entry: 'analytics/api-handler.ts',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadData(reader);

    const uploads = nodeFunction(this, 'Uploads', {
      entry: 'uploads/handler.ts',
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: { BUCKET_NAME: mediaBucket.bucketName },
    });
    // Writes only into the inbox; reads only what the upload flow needs.
    // Listing lets a missing key read as 404 rather than 403.
    mediaBucket.grantPut(uploads, 'inbox/*');
    mediaBucket.grantRead(uploads, 'inbox/*');
    mediaBucket.grantRead(uploads, 'inbox-status/*');
    mediaBucket.grantRead(uploads, 'catalog/*/show.json');
    uploads.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [mediaBucket.bucketArn] }),
    );

    const allowedOrigins = [siteUrl, 'http://localhost:5173'];
    // The browser PUTs parts to presigned URLs and needs each part's ETag back.
    // Set from here because the bucket's stack can't know the dashboard URL.
    const cors = {
      service: 'S3',
      action: 'putBucketCors',
      parameters: {
        Bucket: mediaBucket.bucketName,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ['PUT'],
              AllowedOrigins: allowedOrigins,
              AllowedHeaders: ['content-type'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${mediaBucket.bucketName}-cors`),
    };
    new cr.AwsCustomResource(this, 'MediaBucketCors', {
      onCreate: cors,
      onUpdate: cors,
      onDelete: {
        service: 'S3',
        action: 'deleteBucketCors',
        parameters: { Bucket: mediaBucket.bucketName },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3:PutBucketCORS'],
          resources: [mediaBucket.bucketArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    const api = new apigw.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
    const authorizer = new authorizers.HttpJwtAuthorizer(
      'Cognito',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [client.userPoolClientId] },
    );
    api.addRoutes({
      path: '/shows/{proxy+}',
      methods: [apigw.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('Read', reader),
      authorizer,
    });
    api.addRoutes({
      path: '/shows',
      methods: [apigw.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('ReadShows', reader),
      authorizer,
    });
    const upload = new integrations.HttpLambdaIntegration('Upload', uploads);
    for (const [path, method] of [
      ['/me', apigw.HttpMethod.GET],
      ['/shows/{show}/uploads', apigw.HttpMethod.POST],
      ['/shows/{show}/uploads/{bundleId}', apigw.HttpMethod.GET],
      ['/shows/{show}/uploads/{bundleId}/{action}', apigw.HttpMethod.POST],
    ] as const) {
      api.addRoutes({ path, methods: [method], integration: upload, authorizer });
    }

    const runtimeConfig = {
      apiUrl: api.apiEndpoint,
      authDomain: domain.baseUrl(),
      clientId: client.userPoolClientId,
    };
    new s3deploy.BucketDeployment(this, 'Deploy', {
      destinationBucket: site,
      distribution,
      sources: [
        existsSync(resolve(DIST, 'index.html'))
          ? s3deploy.Source.asset(DIST)
          : s3deploy.Source.data(
              'index.html',
              '<!doctype html><title>DarkRelay</title><p>Dashboard not built. Run <code>npm run build:dashboard</code> and deploy again.</p>',
            ),
        s3deploy.Source.jsonData('config.json', runtimeConfig),
      ],
    });

    new CfnOutput(this, 'DashboardUrl', { value: siteUrl });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
  }
}
