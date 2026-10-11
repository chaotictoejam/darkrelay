import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildFeed,
  episodeId,
  importFeed,
  layout,
  validateFeed,
  type ImportResult,
} from '@darkrelay/core';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { formatResult, readFeedSource } from './validate';

export interface ImportFlags {
  show: string;
  file?: string;
  ownerName?: string;
  ownerEmail?: string;
  dryRun?: boolean;
  out?: string;
  force?: boolean;
}

/**
 * Step 1 of a migration: copies show and episode details into a draft show.
 * Media stays on the old host and nothing public changes.
 */
export async function importCommand(url: string, flags: ImportFlags, global: GlobalOptions) {
  const xml = await readFeedSource(flags.file ?? url);
  const owner =
    flags.ownerEmail || flags.ownerName
      ? { owner: { name: flags.ownerName ?? '', email: flags.ownerEmail ?? '' } }
      : {};
  const result = importFeed(xml, { sourceUrl: url, slug: flags.show, overrides: owner });
  printSummary(result);

  if (flags.dryRun) {
    const out = flags.out ?? `import-${flags.show}`;
    await writeLocal(out, result);
    const preview = buildFeed({
      show: result.show,
      episodes: result.episodes,
      baseUrl: 'https://media.example.invalid',
    });
    await writeFile(join(out, 'feed.preview.xml'), preview);
    console.log(`\nPreview feed validation:\n${formatResult(validateFeed(preview))}`);
    console.log(`\nDry run: wrote ${out}/. Nothing uploaded.`);
    return;
  }

  const bucket = new Bucket((await resolveDeployment(global)).bucket);
  if ((await bucket.exists(layout.showConfig(flags.show))) && !flags.force) {
    throw new Error(`Show "${flags.show}" already exists. Use --force to re-import over it.`);
  }
  for (const ep of result.episodes) {
    await bucket.putText(
      layout.episodeManifest(flags.show, episodeId(ep.guid)),
      JSON.stringify(ep, null, 2),
    );
  }
  // show.json last: writing it triggers the (draft) feed build.
  await bucket.putText(layout.showConfig(flags.show), JSON.stringify(result.show, null, 2));
  console.log(
    `\nImported as draft. Check it with: darkrelay status ${flags.show}\nThe preview feed is private; nothing public has changed.`,
  );
}

function printSummary({ show, episodes, warnings }: ImportResult) {
  console.log(`${show.title}`);
  console.log(`  podcast:guid  ${show.podcastGuid}`);
  console.log(`  episodes      ${episodes.length}`);
  if (episodes.length) {
    const dates = episodes.map((e) => e.pubDate).sort();
    console.log(`  range         ${dates[0]!.slice(0, 10)} .. ${dates.at(-1)!.slice(0, 10)}`);
  }
  for (const w of warnings) console.log(`  warning: ${w}`);
}

async function writeLocal(dir: string, { show, episodes }: ImportResult) {
  await mkdir(join(dir, 'episodes'), { recursive: true });
  await writeFile(join(dir, 'show.json'), JSON.stringify(show, null, 2));
  for (const ep of episodes) {
    await writeFile(
      join(dir, 'episodes', `${episodeId(ep.guid)}.json`),
      JSON.stringify(ep, null, 2),
    );
  }
}
