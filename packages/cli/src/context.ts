import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'node:fs';

export interface Deployment {
  bucket: string;
  baseUrl: string;
}

export interface GlobalOptions {
  stackPrefix: string;
}

/**
 * Finds the deployment from the hosting stack's outputs. DARKRELAY_BUCKET and
 * DARKRELAY_BASE_URL override the lookup (useful in CI or without
 * CloudFormation read access).
 */
export async function resolveDeployment(opts: GlobalOptions): Promise<Deployment> {
  const bucket = process.env['DARKRELAY_BUCKET'];
  const baseUrl = process.env['DARKRELAY_BASE_URL'];
  if (bucket && baseUrl) return { bucket, baseUrl };

  const stackName = `${opts.stackPrefix}Hosting`;
  const cfn = new CloudFormationClient({ region: 'us-east-1' });
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Object.fromEntries(
    (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
  );
  if (!outputs['MediaBucketName'] || !outputs['PublicBaseUrl']) {
    throw new Error(
      `Stack ${stackName} has no MediaBucketName/PublicBaseUrl outputs. Deployed yet?`,
    );
  }
  return { bucket: outputs['MediaBucketName'], baseUrl: outputs['PublicBaseUrl'] };
}

export class Bucket {
  private readonly s3 = new S3Client({ region: 'us-east-1' });
  constructor(readonly name: string) {}

  async getText(key: string): Promise<string | undefined> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.name, Key: key }));
      return await r.Body!.transformToString('utf-8');
    } catch (e) {
      if (e instanceof NoSuchKey) return undefined;
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.name, Key: key }));
      return true;
    } catch (e) {
      if (e instanceof NotFound) return false;
      throw e;
    }
  }

  async putText(key: string, body: string, contentType = 'application/json') {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.name, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** Multipart upload from disk, so large audio and video files are fine. */
  async uploadFile(key: string, path: string, contentType: string, cacheControl?: string) {
    await new Upload({
      client: this.s3,
      params: {
        Bucket: this.name,
        Key: key,
        Body: createReadStream(path),
        ContentType: contentType,
        CacheControl: cacheControl,
      },
    }).done();
  }
}
