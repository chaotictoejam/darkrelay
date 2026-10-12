import {
  Duration,
  Stack,
  type StackProps,
  aws_budgets as budgets,
  aws_cloudfront as cloudfront,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as actions,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { DeploymentConfig } from '../config';

export interface AlertsStackProps extends StackProps {
  config: DeploymentConfig;
  alerts: NonNullable<DeploymentConfig['alerts']>;
  distribution: cloudfront.IDistribution;
}

const GB = 1024 ** 3;

/**
 * Early warning for a traffic spike, the one way DarkRelay's bill can grow
 * fast. Separate from hosting: alerts never touch the download path.
 *
 * - A CloudWatch alarm on this distribution's bytes served per hour fires
 *   within about an hour and sees only DarkRelay traffic. $0.10/month.
 * - An AWS Budget on CloudFront spend catches the money side, including
 *   forecasts. Budgets without actions are free, however many the account
 *   has. Billing data lags by hours, and the budget covers every CloudFront
 *   distribution in the account.
 */
export class AlertsStack extends Stack {
  constructor(scope: Construct, id: string, props: AlertsStackProps) {
    super(scope, id, props);
    const { config, alerts, distribution } = props;

    const topic = new sns.Topic(this, 'Alerts', { displayName: `${config.stackPrefix} alerts` });
    topic.addSubscription(new subscriptions.EmailSubscription(alerts.email));

    const bytes = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: 'BytesDownloaded',
      // CloudFront metrics live in us-east-1 under Region=Global.
      dimensionsMap: { DistributionId: distribution.distributionId, Region: 'Global' },
      statistic: cloudwatch.Stats.SUM,
      period: Duration.hours(1),
    });
    const alarm = new cloudwatch.Alarm(this, 'TransferSpike', {
      alarmDescription: `More than ${alerts.hourlyTransferGB} GB served by ${config.stackPrefix} media in an hour. Past CloudFront's free 1 TB/month that is about $0.085/GB.`,
      metric: bytes,
      threshold: alerts.hourlyTransferGB * GB,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(topic));

    const thresholds = [...alerts.monthlyUsd].sort((a, b) => a - b);
    const subscriber = { subscriptionType: 'EMAIL', address: alerts.email };
    new budgets.CfnBudget(this, 'CloudFrontBudget', {
      budget: {
        budgetName: `${config.stackPrefix}-cloudfront`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: thresholds.at(-1)!, unit: 'USD' },
        costFilters: { Service: ['Amazon CloudFront'] },
      },
      notificationsWithSubscribers: [
        ...thresholds.map((amount) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: amount,
            thresholdType: 'ABSOLUTE_VALUE',
          },
          subscribers: [subscriber],
        })),
        {
          // Warns before the money is spent: the month is on track to pass the first threshold.
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: thresholds[0]!,
            thresholdType: 'ABSOLUTE_VALUE',
          },
          subscribers: [subscriber],
        },
      ],
    });
  }
}
