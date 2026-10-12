import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const Domain = z.discriminatedUnion('dns', [
  z.object({
    /** DNS for this name is in a Route 53 hosted zone in the same account. */
    dns: z.literal('route53'),
    name: z.string().min(3),
    hostedZoneName: z.string().min(3),
    /** Skips a context lookup at synth time when set. */
    hostedZoneId: z.string().optional(),
  }),
  z.object({
    /** DNS is elsewhere. Request the certificate yourself (see README) and pass its ARN. */
    dns: z.literal('external'),
    name: z.string().min(3),
    certificateArn: z.string().startsWith('arn:aws:acm:us-east-1:'),
  }),
]);

export const DeploymentConfig = z.object({
  /** Prefix for stack and resource names; change it to run two deployments in one account. */
  stackPrefix: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,30}$/)
    .default('DarkRelay'),
  account: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
  /** Omit to use the CloudFront default domain (*.cloudfront.net). */
  domain: Domain.optional(),
  logs: z
    .object({ retentionDays: z.number().int().positive().default(90) })
    .default({ retentionDays: 90 }),
  /** Fargate size for video transcoding. Bigger is faster; Spot price scales with it. */
  transcoder: z
    .object({
      cpu: z
        .union([
          z.literal(1024),
          z.literal(2048),
          z.literal(4096),
          z.literal(8192),
          z.literal(16384),
        ])
        .default(4096),
      memoryMiB: z.number().int().min(2048).default(8192),
      /** Scratch disk for the source video plus outputs. 21-200 GiB; the first 20 are free. */
      ephemeralGiB: z.number().int().min(21).max(200).default(60),
      /** Set explicitly so synth needs no AWS lookup. Every us-east-1 account has a and b. */
      availabilityZones: z
        .array(z.string().startsWith('us-east-1'))
        .min(1)
        .default(['us-east-1a', 'us-east-1b']),
    })
    .default({
      cpu: 4096,
      memoryMiB: 8192,
      ephemeralGiB: 60,
      availabilityZones: ['us-east-1a', 'us-east-1b'],
    }),
  /** CloudFront edge coverage. "100" (North America and Europe) is the cheapest. */
  priceClass: z.enum(['100', '200', 'All']).default('100'),
});
export type DeploymentConfig = z.infer<typeof DeploymentConfig>;
export type DeploymentConfigInput = z.input<typeof DeploymentConfig>;

export function loadConfig(path = process.env['DARKRELAY_CONFIG']): DeploymentConfig {
  const file = resolve(path ?? resolve(import.meta.dirname, '../../../darkrelay.config.json'));
  if (!existsSync(file)) {
    throw new Error(
      `No deployment config at ${file}. Copy darkrelay.config.example.json to darkrelay.config.json and edit it.`,
    );
  }
  const parsed = DeploymentConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
