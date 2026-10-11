import { readFile } from 'node:fs/promises';
import { validateFeed, type ValidationResult } from '@darkrelay/core';

export async function readFeedSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers: { 'User-Agent': 'DarkRelay/0.1 (+https://github.com/chaotictoejam/darkrelay)' },
    });
    if (!res.ok) throw new Error(`GET ${source}: HTTP ${res.status}`);
    return res.text();
  }
  return readFile(source, 'utf8');
}

export function formatResult(r: ValidationResult): string {
  const lines = [
    ...r.errors.map((i) => `error   ${i.path}: ${i.message}`),
    ...r.warnings.map((i) => `warning ${i.path}: ${i.message}`),
    r.ok
      ? `OK (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})`
      : `FAILED with ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`,
  ];
  return lines.join('\n');
}

export async function validate(source: string) {
  const result = validateFeed(await readFeedSource(source));
  console.log(formatResult(result));
  if (!result.ok) process.exitCode = 1;
}
