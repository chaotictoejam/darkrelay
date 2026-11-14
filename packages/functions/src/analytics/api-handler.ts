import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { accessFromGroups, groupsClaim } from '@darkrelay/core';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { doc, queryAll } from './dynamo';
import { route, type Query } from './api';

const table = process.env['TABLE_NAME']!;

const query: Query = async (pk, sk) => {
  const values: Record<string, unknown> = { ':pk': pk };
  let condition = 'pk = :pk';
  if (sk?.between) {
    condition += ' AND sk BETWEEN :a AND :b';
    values[':a'] = sk.between[0];
    values[':b'] = sk.between[1];
  } else if (sk?.beginsWith) {
    condition += ' AND begins_with(sk, :p)';
    values[':p'] = sk.beginsWith;
  }
  if (sk?.latest) {
    const r = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: condition,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    return (r.Items ?? []) as Record<string, unknown>[];
  }
  return queryAll({
    TableName: table,
    KeyConditionExpression: condition,
    ExpressionAttributeValues: values,
  });
};

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const access = accessFromGroups(
    groupsClaim(event.requestContext.authorizer.jwt.claims['cognito:groups']),
  );
  const res = await route(query, event.rawPath, event.queryStringParameters ?? {}, access);
  return {
    statusCode: res.statusCode,
    // Not cached. These reads are small pre-aggregated queries, so a minute
    // of browser caching saved very little and cost correctness: a brand
    // whose icon or name was just changed came back from the cache with the
    // old one, and a refresh looked as though the change had been lost.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(res.body),
  };
}
