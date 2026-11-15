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
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  custom_resources as cr,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { ADMIN_GROUP, metricKeys, routesFor, type RouteOwner } from '@darkrelay/core';
import type { DeploymentConfig } from '../config';
import { REPO_ROOT, nodeFunction } from '../lambda';

export interface DashboardStackProps extends StackProps {
  config: DeploymentConfig;
  table: dynamodb.ITable;
  mediaBucket: s3.IBucket;
  /**
   * Slot scoring and planning, from the analytics stack. The schedule routes
   * go straight to it: it already holds exactly the permissions planning
   * needs, and granting them to a second function would only widen what a
   * dashboard request can reach.
   */
  planner: lambda.IFunction;
  /** Public media base URL, so the dashboard can show brand icons. */
  publicBaseUrl: string;
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
    mediaBucket.grantRead(uploads, 'catalog/*/episodes/*');
    // A Shorts batch is checked against the brand's outlets before its
    // manifest is written. Reading brand.json is all that needs: the content
    // records are written by the ingest, not from the browser.
    mediaBucket.grantRead(uploads, 'catalog/*/brand.json');
    uploads.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [mediaBucket.bucketArn] }),
    );

    // Brand writes: the icon today. Reads stay with the analytics function,
    // which never touches S3; this one holds only what changing brand.json
    // needs, so a dashboard read can't reach the catalog.
    const brandWrites = nodeFunction(this, 'BrandWrites', {
      entry: 'brands/handler.ts',
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: {
        BUCKET_NAME: mediaBucket.bucketName,
        TABLE_NAME: table.tableName,
        PUBLIC_BASE_URL: props.publicBaseUrl,
      },
    });
    mediaBucket.grantRead(brandWrites, 'catalog/*/brand.json');
    mediaBucket.grantRead(brandWrites, 'catalog/*/show.json');
    mediaBucket.grantPut(brandWrites, 'catalog/*/brand.json');
    // Icons are the only public object this function writes, and they are
    // content-addressed, so it can never overwrite a feed or an episode file.
    mediaBucket.grantPut(brandWrites, 'public/*/icon-*');
    brandWrites.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [mediaBucket.bucketArn] }),
    );
    // The brand rows only: every one of them shares a partition key, so the
    // row a brand change writes is the only kind of item this function can
    // touch. Numbers are written by the ingestion runs, nothing else.
    brandWrites.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [metricKeys.brandsPk] },
        },
      }),
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
    // Every route the API carries comes from the table in `@darkrelay/core`,
    // which the dashboard builds its paths from as well. That is the whole
    // point of the table: a handler with no route in front of it used to
    // reach the browser as API Gateway's own CORS-less 404, which `fetch`
    // reports as a bare "NetworkError". Add an endpoint there, not here.
    //
    // Who may call what is not decided here either: every route takes the
    // same JWT authorizer, and each router checks whether the caller's
    // groups allow the brand and the action.
    const owners: { owner: RouteOwner; id: string; fn: lambda.IFunction }[] = [
      { owner: 'reader', id: 'Read', fn: reader },
      { owner: 'uploads', id: 'Upload', fn: uploads },
      { owner: 'planner', id: 'Schedule', fn: props.planner },
      { owner: 'brandWrites', id: 'BrandWrite', fn: brandWrites },
    ];
    for (const { owner, id, fn } of owners) {
      const integration = new integrations.HttpLambdaIntegration(id, fn);
      for (const route of routesFor(owner)) {
        api.addRoutes({
          path: route.path,
          methods: [apigw.HttpMethod[route.method]],
          integration,
          authorizer,
        });
      }
    }

    // A path with no route of its own still has to reach one, or the browser
    // gets a 404 it is not allowed to read.
    //
    // Two things about this are load-bearing, both measured against a real
    // HTTP API rather than reasoned about:
    //
    // OPTIONS is absent. API Gateway answers preflight itself, ahead of
    // routing, but only for a request no route claims. A `$default` route
    // claims preflight, and the reply then carries no CORS headers at all —
    // which fails every request the dashboard makes, not just the unrouted
    // ones. Listing the methods leaves preflight where it belongs.
    //
    // `/{proxy+}` and not `$default`, for the same reason. A greedy variable
    // only conflicts with another variable at its own level, and nothing
    // else is variable at the first segment, so this sits happily beside the
    // reader's `/brands/{proxy+}`.
    const notFound = nodeFunction(this, 'NotFound', { entry: 'lib/not-found.ts' });
    api.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigw.HttpMethod.GET,
        apigw.HttpMethod.POST,
        apigw.HttpMethod.PUT,
        apigw.HttpMethod.PATCH,
        apigw.HttpMethod.DELETE,
        apigw.HttpMethod.HEAD,
      ],
      integration: new integrations.HttpLambdaIntegration('NotFound', notFound),
      authorizer,
    });

    const runtimeConfig = {
      apiUrl: api.apiEndpoint,
      authDomain: domain.baseUrl(),
      clientId: client.userPoolClientId,
      mediaUrl: props.publicBaseUrl,
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
