const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface QueryTarget {
  database: string;
  table: string;
  distributionId: string;
}

function partition(date: Date) {
  return `(year = ${date.getUTCFullYear()} AND month = ${date.getUTCMonth() + 1} AND day = ${date.getUTCDate()})`;
}

/**
 * One UTC day of enclosure requests, grouped by file + IP + User-Agent
 * (the IAB dedupe key, calendar-day window). Log files are partitioned by
 * delivery hour, so the first hours of the next day are scanned too and
 * rows are filtered on the request's own date. IPs are grouped on, never
 * returned.
 */
export function dailyQuery(target: QueryTarget, date: string): string {
  if (!DATE.test(date)) throw new Error(`Invalid date ${date}`);
  if (!/^[A-Z0-9]+$/.test(target.distributionId)) throw new Error('Invalid distribution id');
  const day = new Date(`${date}T00:00:00Z`);
  const next = new Date(day.getTime() + 86_400_000);
  return `SELECT
  cs_uri_stem AS path,
  cs_user_agent AS user_agent,
  arbitrary(c_country) AS country,
  count(*) AS requests,
  sum(coalesce(try_cast(sc_bytes AS bigint), 0)) AS bytes
FROM "${target.database}"."${target.table}"
WHERE distributionid = '${target.distributionId}'
  AND (${partition(day)} OR (${partition(next)} AND hour < 3))
  AND "date" = '${date}'
  AND cs_method = 'GET'
  AND sc_status IN ('200', '206')
  AND regexp_like(cs_uri_stem, '/audio\\.(mp3|m4a)$')
GROUP BY cs_uri_stem, c_ip, cs_user_agent`;
}
