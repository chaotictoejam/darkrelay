import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'transcoder', testTimeout: 120_000 } });
