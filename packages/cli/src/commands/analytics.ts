import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { ACCESS_LOG_PREFIX } from '@darkrelay/core';
import { stackOutputs, type GlobalOptions } from '../context';

const region = 'us-east-1';

/** Dates from --date/--from/--to, defaulting to yesterday. */
export function datesFor(
  flags: { date?: string[]; from?: string; to?: string },
  now = new Date(),
): string[] {
  const valid = (d: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))
      throw new Error(`Bad date ${d}`);
    return d;
  };
  if (flags.date?.length) return flags.date.map(valid);
  if (flags.from) {
    const to = valid(flags.to ?? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10));
    const out: string[] = [];
    for (let t = Date.parse(valid(flags.from)); t <= Date.parse(to); t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    if (out.length > 400) throw new Error('At most 400 days per run');
    return out;
  }
  return [new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)];
}

/** Runs the nightly aggregation now for the given days. Safe to repeat. */
export async function runAnalytics(
  flags: { date?: string[]; from?: string; to?: string; source?: string },
  global: GlobalOptions,
) {
  const dates = datesFor(flags);
  const out = await stackOutputs(global, 'Analytics');
  const lambda = new LambdaClient({ region });
  if (flags.source === 'youtube') {
    const range = { from: dates[0]!, to: dates.at(-1)! };
    console.log(`Pulling YouTube Analytics ${range.from} to ${range.to} ...`);
    const r = await lambda.send(
      new InvokeCommand({
        FunctionName: out['YouTubeAnalyticsFunctionName'],
        Payload: new TextEncoder().encode(JSON.stringify(range)),
      }),
    );
    const body = new TextDecoder().decode(r.Payload ?? new Uint8Array());
    if (r.FunctionError) throw new Error(`YouTube pull failed: ${body}`);
    console.log(`  ${JSON.stringify(JSON.parse(body).shows)}`);
    return;
  }
  if (flags.source && flags.source !== 'cloudfront')
    throw new Error(`Unknown source "${flags.source}" (cloudfront or youtube)`);
  // A few days per invocation keeps each well inside the Lambda timeout.
  for (let i = 0; i < dates.length; i += 5) {
    const batch = dates.slice(i, i + 5);
    console.log(`Counting ${batch.join(', ')} ...`);
    const r = await lambda.send(
      new InvokeCommand({
        FunctionName: out['AggregatorFunctionName'],
        Payload: new TextEncoder().encode(JSON.stringify({ dates: batch })),
      }),
    );
    const body = JSON.parse(new TextDecoder().decode(r.Payload ?? new Uint8Array()) || 'null');
    if (r.FunctionError) throw new Error(`Aggregator failed: ${JSON.stringify(body)}`);
    for (const run of body as {
      date: string;
      episodes: number;
      groups: number;
      filtered: unknown;
    }[]) {
      console.log(
        `  ${run.date}: ${run.groups} listener groups, ${run.episodes} episodes, filtered ${JSON.stringify(run.filtered)}`,
      );
    }
  }
}

/**
 * First-deploy sanity check: are logs landing where the Glue table expects,
 * and can Athena read them? Prints the newest log objects and a row count.
 */
export async function checkAnalytics(global: GlobalOptions) {
  const hosting = await stackOutputs(global, 'Hosting');
  const analytics = await stackOutputs(global, 'Analytics');
  const s3 = new S3Client({ region });
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: hosting['LogBucketName'],
      Prefix: `${ACCESS_LOG_PREFIX}/`,
      MaxKeys: 1000,
    }),
  );
  const keys = (listed.Contents ?? []).map((o) => o.Key!).sort();
  if (!keys.length) {
    console.log(`No logs under s3://${hosting['LogBucketName']}/${ACCESS_LOG_PREFIX}/ yet.`);
    console.log(
      'CloudFront delivers within minutes of the first requests. Download an episode, then retry.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Newest log objects:\n  ${keys.slice(-3).join('\n  ')}`);

  const athena = new AthenaClient({ region });
  const sql = `SELECT count(*) AS requests, min("date") AS first_day, max("date") AS last_day,
  count_if(c_ip LIKE '%.%' OR c_ip LIKE '%:%') AS with_ip, count_if(c_country <> '' AND c_country <> '-') AS with_country
FROM "${analytics['GlueDatabase']}"."cloudfront_logs"
WHERE year >= ${new Date().getUTCFullYear() - 1}`;
  const { QueryExecutionId } = await athena.send(
    new StartQueryExecutionCommand({ QueryString: sql, WorkGroup: analytics['AthenaWorkGroup'] }),
  );
  for (;;) {
    const r = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
    const state = r.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      console.log(`Athena could not read the logs: ${r.QueryExecution?.Status?.StateChangeReason}`);
      process.exitCode = 1;
      return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId }));
  const [header, row] = (res.ResultSet?.Rows ?? []).map(
    (r) => r.Data?.map((d) => d.VarCharValue ?? '') ?? [],
  );
  const result = Object.fromEntries((header ?? []).map((h, i) => [h, row?.[i] ?? '']));
  console.log(`Athena: ${JSON.stringify(result)}`);
  if (result['requests'] === '0') {
    console.log(
      'Logs exist but the table reads 0 rows: the partition path does not match. Compare the keys above with the Glue table location.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      'Logs are readable. Counts appear after the nightly run, or now with: darkrelay analytics run',
    );
  }
}

export async function addDashboardUser(email: string, global: GlobalOptions) {
  const out = await stackOutputs(global, 'Dashboard');
  const cognito = new CognitoIdentityProviderClient({ region });
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: out['UserPoolId'],
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }),
  );
  console.log(
    `Invited ${email}. Cognito emails a temporary password; sign in at ${out['DashboardUrl']}`,
  );
}

export async function removeDashboardUser(email: string, global: GlobalOptions) {
  const out = await stackOutputs(global, 'Dashboard');
  const cognito = new CognitoIdentityProviderClient({ region });
  await cognito.send(
    new AdminDeleteUserCommand({ UserPoolId: out['UserPoolId'], Username: email }),
  );
  console.log(`Removed ${email} from the dashboard`);
}
