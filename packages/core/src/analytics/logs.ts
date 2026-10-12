/**
 * CloudFront standard logging (v2) layout, shared by the delivery config,
 * the Glue table and the aggregation query so they can't drift apart.
 *
 * Logs land at s3://<log bucket>/cloudfront/distributionid=<id>/year=YYYY/month=MM/day=DD/hour=HH/
 * (Hive-style; {distributionid} must be lowercase for Glue).
 */
export const ACCESS_LOG_PREFIX = 'cloudfront';
export const ACCESS_LOG_SUFFIX = '{distributionid}/{yyyy}/{MM}/{dd}/{HH}';

/** Fields requested from CloudFront. `c-country` and `asn` are v2-only fields. */
export const ACCESS_LOG_FIELDS = [
  'date',
  'time',
  'c-ip',
  'cs-method',
  'cs-uri-stem',
  'sc-status',
  'sc-bytes',
  'cs(User-Agent)',
  'cs(Referer)',
  'sc-range-start',
  'sc-range-end',
  'sc-content-len',
  'x-edge-request-id',
  'c-country',
  'asn',
] as const;

/** Column name CloudFront uses in Parquet output: `cs(User-Agent)` -> `cs_user_agent`. */
export function parquetColumn(field: string): string {
  return field
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
