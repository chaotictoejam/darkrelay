#!/usr/bin/env node
// Runs the TypeScript CLI directly; no build step.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
