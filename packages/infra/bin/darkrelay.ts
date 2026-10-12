import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { AnalyticsStack } from '../lib/stacks/analytics-stack';
import { DashboardStack } from '../lib/stacks/dashboard-stack';
import { HostingStack } from '../lib/stacks/hosting-stack';
import { PublishStack } from '../lib/stacks/publish-stack';

const config = loadConfig();
const app = new App();
// us-east-1 only: CloudFront certificates and log delivery sources must live there.
const env = { account: config.account ?? process.env['CDK_DEFAULT_ACCOUNT'], region: 'us-east-1' };

const hosting = new HostingStack(app, `${config.stackPrefix}Hosting`, { env, config });
new PublishStack(app, `${config.stackPrefix}Publish`, {
  env,
  mediaBucket: hosting.mediaBucket,
  distribution: hosting.distribution,
  publicBaseUrl: hosting.publicBaseUrl,
  stackPrefix: config.stackPrefix,
});
const analytics = new AnalyticsStack(app, `${config.stackPrefix}Analytics`, {
  env,
  config,
  logBucket: hosting.logBucket,
  mediaBucket: hosting.mediaBucket,
  distribution: hosting.distribution,
});
new DashboardStack(app, `${config.stackPrefix}Dashboard`, { env, config, table: analytics.table });
