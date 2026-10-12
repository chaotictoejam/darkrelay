import { resolve } from 'node:path';
import {
  Duration,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export interface NodeFunctionProps {
  /** Path under packages/functions/src, e.g. 'publisher/handler.ts'. */
  entry: string;
  environment?: Record<string, string>;
  memorySize?: number;
  timeout?: Duration;
  /** Fixed name, for functions that must reference their own ARN without a CloudFormation cycle. */
  functionName?: string;
}

/** Node 22 on arm64, bundled from the functions package, logs kept a month. */
export function nodeFunction(scope: Construct, id: string, props: NodeFunctionProps) {
  return new nodejs.NodejsFunction(scope, id, {
    entry: resolve(REPO_ROOT, 'packages/functions/src', props.entry),
    functionName: props.functionName,
    projectRoot: REPO_ROOT,
    depsLockFilePath: resolve(REPO_ROOT, 'package-lock.json'),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize ?? 512,
    timeout: props.timeout ?? Duration.minutes(1),
    environment: { NODE_OPTIONS: '--enable-source-maps', ...props.environment },
    bundling: {
      minify: true,
      sourceMap: true,
      target: 'node22',
      format: nodejs.OutputFormat.CJS,
    },
    logGroup: new logs.LogGroup(scope, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH }),
  });
}
