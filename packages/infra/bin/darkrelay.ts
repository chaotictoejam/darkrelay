import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
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
});
