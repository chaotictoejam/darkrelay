import type { z } from 'zod';

/** What a dashboard API route answers with, before the handler serialises it. */
export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

/**
 * An error the dashboard can show. A list is sent as both one `error` string
 * and an `errors` array, so a form can print the problems one per line.
 */
export const error = (statusCode: number, message: string | string[]): ApiResponse => ({
  statusCode,
  body: Array.isArray(message)
    ? { error: message.join('\n'), errors: message }
    : { error: message },
});

export const isResponse = (v: unknown): v is ApiResponse =>
  typeof v === 'object' && v !== null && 'statusCode' in v;

/** The parsed body, or the 400 to return instead. */
export function parse<T>(schema: z.ZodType<T>, body: unknown): T | ApiResponse {
  const r = schema.safeParse(body);
  return r.success
    ? r.data
    : error(
        400,
        r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
}
