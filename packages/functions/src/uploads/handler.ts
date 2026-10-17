import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SLUG, accessFromGroups, groupsClaim, newBundleId, newEpisodeGuid } from '@darkrelay/core';
import { S3Store } from '../lib/store';
import { route, type UploadDeps } from './api';

const bucket = process.env['BUCKET_NAME']!;
/** Each part URL is good for this long; the browser asks for more as it goes. */
const PART_URL_SECONDS = 15 * 60;

// Without this the SDK adds a checksum of an empty body to signed part URLs,
// and S3 rejects the real bytes.
const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });

const deps: UploadDeps = {
  store: new S3Store(bucket, s3),
  multipart: {
    async create(key, contentType) {
      const r = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      );
      return r.UploadId!;
    },
    signPart(key, uploadId, partNumber) {
      return getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: PART_URL_SECONDS },
      );
    },
    async complete(key, uploadId, parts) {
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    },
  },
  async listShows() {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'catalog/', Delimiter: '/' }),
    );
    return (r.CommonPrefixes ?? [])
      .map((p) => p.Prefix!.slice('catalog/'.length, -1))
      .filter((s) => SLUG.test(s))
      .sort();
  },
  newBundleId: () => newBundleId(),
  newGuid: newEpisodeGuid,
  now: () => new Date(),
};

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const access = accessFromGroups(
    groupsClaim(event.requestContext.authorizer.jwt.claims['cognito:groups']),
  );
  let body: unknown;
  try {
    body = event.body
      ? JSON.parse(
          event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body,
        )
      : undefined;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body is not valid JSON' }) };
  }
  const res = await route(deps, {
    method: event.requestContext.http.method,
    path: event.rawPath,
    body,
    access,
  });
  return {
    statusCode: res.statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(res.body),
  };
}
