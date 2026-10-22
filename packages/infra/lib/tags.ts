import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { DeploymentConfig } from './config';

/**
 * Cost allocation tags for every taggable resource in a deployment, so Cost
 * Explorer can filter and group DarkRelay spend. Activate the keys once under
 * Billing → Cost allocation tags; AWS lists them about a day after first use.
 */
export function deploymentTags(config: DeploymentConfig): Record<string, string> {
  return { Project: 'DarkRelay', Deployment: config.stackPrefix, ...config.tags };
}

export function tagDeployment(scope: IConstruct, config: DeploymentConfig): void {
  for (const [key, value] of Object.entries(deploymentTags(config))) {
    Tags.of(scope).add(key, value);
  }
}
