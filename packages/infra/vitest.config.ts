import { defineProject } from 'vitest/config';

// cdk.out holds esbuild bundles of the other packages, tests included. They
// are snapshots of whatever was synthed last, so running them tests old code.
export default defineProject({
  test: { name: 'infra', testTimeout: 120_000, exclude: ['**/node_modules/**', 'cdk.out/**'] },
});
