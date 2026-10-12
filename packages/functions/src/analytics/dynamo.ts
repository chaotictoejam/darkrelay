import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function putAll(table: string, items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += 25) {
    let pending: Record<string, unknown>[] = items.slice(i, i + 25);
    for (let attempt = 0; pending.length && attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const r = await doc.send(
        new BatchWriteCommand({
          RequestItems: { [table]: pending.map((Item) => ({ PutRequest: { Item } })) },
        }),
      );
      pending = (r.UnprocessedItems?.[table] ?? []).map((w) => w.PutRequest!.Item!);
    }
    if (pending.length) throw new Error(`${pending.length} items not written after retries`);
  }
}

export async function queryAll<T>(input: QueryCommandInput): Promise<T[]> {
  const out: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    out.push(...((r.Items ?? []) as T[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}
