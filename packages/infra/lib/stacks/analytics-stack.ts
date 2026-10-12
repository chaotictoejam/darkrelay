import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_athena as athena,
  aws_cloudfront as cloudfront,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_glue as glue,
  aws_iam as iam,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { ACCESS_LOG_FIELDS, ACCESS_LOG_PREFIX, parquetColumn } from '@darkrelay/core';
import type { Construct } from 'constructs';
import type { DeploymentConfig } from '../config';
import { nodeFunction } from '../lambda';

export interface AnalyticsStackProps extends StackProps {
  config: DeploymentConfig;
  logBucket: s3.IBucket;
  mediaBucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
}

export const LOG_TABLE = 'cloudfront_logs';
export const ATHENA_RESULTS_PREFIX = 'athena-results/';

/**
 * Nightly download counting. Athena reads the CloudFront Parquet logs once a
 * day and a Lambda writes daily aggregates to DynamoDB. The dashboard reads
 * DynamoDB only; nothing here is on the download path.
 */
export class AnalyticsStack extends Stack {
  readonly table: dynamodb.Table;
  readonly aggregator: ReturnType<typeof nodeFunction>;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const { config, logBucket, mediaBucket, distribution } = props;
    const database = `${config.stackPrefix.toLowerCase()}_analytics`;

    this.table = new dynamodb.Table(this, 'Metrics', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const db = new glue.CfnDatabase(this, 'Database', {
      catalogId: this.account,
      databaseInput: { name: database, description: 'DarkRelay CloudFront access logs' },
    });

    const location = `s3://${logBucket.bucketName}/${ACCESS_LOG_PREFIX}`;
    const logTable = new glue.CfnTable(this, 'LogTable', {
      catalogId: this.account,
      databaseName: database,
      tableInput: {
        name: LOG_TABLE,
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'distributionid', type: 'string' },
          { name: 'year', type: 'int' },
          { name: 'month', type: 'int' },
          { name: 'day', type: 'int' },
          { name: 'hour', type: 'int' },
        ],
        parameters: {
          classification: 'parquet',
          'projection.enabled': 'true',
          'projection.distributionid.type': 'enum',
          'projection.distributionid.values': distribution.distributionId,
          'projection.year.type': 'integer',
          'projection.year.range': '2024,2100',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'projection.hour.type': 'integer',
          'projection.hour.range': '0,23',
          'projection.hour.digits': '2',
          'storage.location.template': `${location}/distributionid=\${distributionid}/year=\${year}/month=\${month}/day=\${day}/hour=\${hour}`,
        },
        storageDescriptor: {
          location,
          // CloudFront writes every field as a string, with snake_case column names.
          columns: ACCESS_LOG_FIELDS.map((f) => ({ name: parquetColumn(f), type: 'string' })),
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
        },
      },
    });
    logTable.addResourceDependency(db);

    const workgroupName = `${config.stackPrefix}-analytics`;
    const workgroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: workgroupName,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        // A guard against a runaway query; a day of personal-scale logs is kilobytes.
        bytesScannedCutoffPerQuery: 1_000_000_000,
        resultConfiguration: {
          outputLocation: `s3://${logBucket.bucketName}/${ATHENA_RESULTS_PREFIX}`,
        },
      },
    });

    this.aggregator = nodeFunction(this, 'Aggregator', {
      entry: 'analytics/aggregate-handler.ts',
      timeout: Duration.minutes(10),
      environment: {
        TABLE_NAME: this.table.tableName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        GLUE_DATABASE: database,
        GLUE_TABLE: LOG_TABLE,
        WORKGROUP: workgroupName,
        DISTRIBUTION_ID: distribution.distributionId,
      },
    });
    this.table.grantReadWriteData(this.aggregator);
    mediaBucket.grantRead(this.aggregator, 'catalog/*');
    logBucket.grantRead(this.aggregator, `${ACCESS_LOG_PREFIX}/*`);
    logBucket.grantReadWrite(this.aggregator, `${ATHENA_RESULTS_PREFIX}*`);
    this.aggregator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
        ],
        resources: [
          this.formatArn({ service: 'athena', resource: 'workgroup', resourceName: workgroupName }),
        ],
      }),
    );
    this.aggregator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions'],
        resources: [
          this.formatArn({ service: 'glue', resource: 'catalog' }),
          this.formatArn({ service: 'glue', resource: 'database', resourceName: database }),
          this.formatArn({
            service: 'glue',
            resource: 'table',
            resourceName: `${database}/${LOG_TABLE}`,
          }),
        ],
      }),
    );
    this.aggregator.node.addDependency(workgroup);

    // 03:20 UTC: yesterday's logs have landed; re-runs the day before for stragglers.
    new events.Rule(this, 'Nightly', {
      description: 'Count downloads from yesterday',
      schedule: events.Schedule.cron({ minute: '20', hour: '3' }),
      targets: [new eventTargets.LambdaFunction(this.aggregator, { retryAttempts: 2 })],
    });

    new CfnOutput(this, 'MetricsTableName', { value: this.table.tableName });
    new CfnOutput(this, 'AggregatorFunctionName', { value: this.aggregator.functionName });
    new CfnOutput(this, 'AthenaWorkGroup', { value: workgroupName });
    new CfnOutput(this, 'GlueDatabase', { value: database });
  }
}
