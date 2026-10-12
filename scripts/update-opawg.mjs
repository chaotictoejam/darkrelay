// Refreshes the vendored OPAWG user-agent lists (MIT) from a pinned commit.
// Usage: node scripts/update-opawg.mjs [commit]
import { mkdir, writeFile } from 'node:fs/promises';

const commit = process.argv[2] ?? 'master';
const base = `https://raw.githubusercontent.com/opawg/user-agents-v2/${commit}`;
const out = new URL('../packages/core/src/analytics/opawg/', import.meta.url);
await mkdir(out, { recursive: true });

for (const file of ['bots', 'apps', 'libraries', 'browsers', 'devices']) {
  const res = await fetch(`${base}/src/${file}.json`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const { entries } = await res.json();
  // Keep only what classification needs; examples and docs stay upstream.
  const slim = entries.map(({ name, pattern, category }) =>
    category ? { name, pattern, category } : { name, pattern },
  );
  await writeFile(new URL(`${file}.json`, out), JSON.stringify(slim, null, 0) + '\n');
}
const license = await (await fetch(`${base}/LICENSE`)).text();
await writeFile(new URL('LICENSE', out), license);
await writeFile(
  new URL('SOURCE.md', out),
  `Vendored from https://github.com/opawg/user-agents-v2 at \`${commit}\` by scripts/update-opawg.mjs.\n`,
);
console.log(`Updated OPAWG lists from ${commit}`);
