import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { accessFromGroups, groupsClaim } from '@darkrelay/core';
import { putItem } from '../analytics/dynamo';
import { S3Store } from '../lib/store';
import { route, type BrandDeps } from './api';

const bucket = process.env['BUCKET_NAME']!;
const table = process.env['TABLE_NAME']!;

const deps: BrandDeps = {
  store: new S3Store(bucket),
  saveMeta: (item) => putItem(table, item),
  publicBaseUrl: process.env['PUBLIC_BASE_URL'],
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
