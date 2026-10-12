import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const res = await route(query, event.rawPath, event.queryStringParameters ?? {});
  return {
    statusCode: res.statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' },
    body: JSON.stringify(res.body),
  };
}
