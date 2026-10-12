import { defineProject } from 'vitest/config';

// Date parsing tests assume a zone with DST; workers inherit this.
process.env['TZ'] = 'America/New_York';

export default defineProject({ test: { name: 'cli' } });
