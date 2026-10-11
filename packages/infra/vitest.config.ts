import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'infra', testTimeout: 120_000 } });
