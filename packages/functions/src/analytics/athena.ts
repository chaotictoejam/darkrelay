import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';

export interface QueryStats {
  rows: number;
  bytesScanned: number;
}

/** Runs a query in the workgroup and returns rows as objects keyed by column. */
export async function runQuery(
  client: AthenaClient,
  sql: string,
  workgroup: string,
  timeoutMs = 240_000,
): Promise<{ rows: Record<string, string>[]; stats: QueryStats }> {
  const { QueryExecutionId: id } = await client.send(
    new StartQueryExecutionCommand({ QueryString: sql, WorkGroup: workgroup }),
  );
  const until = Date.now() + timeoutMs;
  let bytesScanned = 0;
  for (;;) {
    const r = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = r.QueryExecution?.Status?.State;
    bytesScanned = r.QueryExecution?.Statistics?.DataScannedInBytes ?? 0;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${state}: ${r.QueryExecution?.Status?.StateChangeReason}`);
    }
    if (Date.now() > until) throw new Error(`Athena query ${id} timed out`);
    await new Promise((res) => setTimeout(res, 1000));
  }

  const rows: Record<string, string>[] = [];
  let columns: string[] | undefined;
  let token: string | undefined;
  do {
    const page = await client.send(
      new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: token, MaxResults: 1000 }),
    );
    columns ??= page.ResultSet?.ResultSetMetadata?.ColumnInfo?.map((c) => c.Name!) ?? [];
    for (const row of page.ResultSet?.Rows ?? []) {
      const values = row.Data?.map((d) => d.VarCharValue ?? '') ?? [];
      // The first row of the first page repeats the column names.
      if (rows.length === 0 && !token && values.every((v, i) => v === columns![i])) continue;
      rows.push(Object.fromEntries(columns.map((c, i) => [c, values[i] ?? ''])));
    }
    token = page.NextToken;
  } while (token);
  return { rows, stats: { rows: rows.length, bytesScanned } };
}
