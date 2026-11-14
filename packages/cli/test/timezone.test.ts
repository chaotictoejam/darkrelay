import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('shorts timezone option', () => {
  it.each(['plan', 'slots'])(
    'rejects an invalid zone in %s before reading AWS config',
    (command) => {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/index.ts', import.meta.url)),
          'shorts',
          command,
          'example',
          '--zone',
          'Mars/Phobos',
        ],
        { encoding: 'utf8', env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid time zone: Mars/Phobos');
    },
  );
});
