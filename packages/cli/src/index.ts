#!/usr/bin/env -S npx tsx
import { Command, Option } from 'commander';
import type { GlobalOptions } from './context';
import { setEpisodeStatus } from './commands/episode';
import { importCommand } from './commands/import';
import { publish } from './commands/publish';
import { putShow, requestRebuild, setShowStatus, showStatus } from './commands/show';
import { validate } from './commands/validate';

const program = new Command('darkrelay')
  .description('Publish podcasts to your own DarkRelay deployment')
  .option('--stack-prefix <prefix>', 'deployment stack prefix', 'DarkRelay');
const g = () => program.opts<GlobalOptions>();

const show = program.command('show').description('Manage shows');
show
  .command('put <file>')
  .description('Create or update a show from a JSON file')
  .option('--image <path>', 'upload show artwork (JPEG or PNG, 1400-3000 px square)')
  .action((file, o) => putShow(file, o, g()));
show
  .command('go-live <slug>')
  .description('Publish the public feed for a draft show')
  .action((slug) => setShowStatus(slug, 'live', g()));
show
  .command('draft <slug>')
  .description('Stop updating the public feed (the last one stays up)')
  .action((slug) => setShowStatus(slug, 'draft', g()));

program
  .command('publish <path>')
  .description('Publish an audio file, or a bundle directory with episode.json')
  .requiredOption('--show <slug>')
  .option('--title <title>')
  .option('--description <html>', 'show notes (HTML)')
  .option('--notes <file>', 'read show notes (HTML) from a file')
  .option('--pub-date <iso>', 'release time; a future date schedules the episode')
  .option('--season <n>')
  .option('--episode <n>')
  .addOption(new Option('--type <type>').choices(['full', 'trailer', 'bonus']))
  .option('--explicit', 'mark as explicit')
  .option('--guid <guid>', 'update an existing episode')
  .option('--transcript <file>', 'VTT, SRT or Podcasting 2.0 JSON')
  .option('--chapters <file>', 'Podcasting 2.0 JSON chapters')
  .option('--cover <file>', 'episode artwork')
  .option('--video <file>', 'video for the phase 3 pipeline')
  .option('--no-wait', "don't wait for the publish result")
  .action((path, o) => publish(path, o, g()));

program
  .command('import <feedUrl>')
  .description('Import an existing feed as a draft show (media stays on the old host)')
  .requiredOption('--show <slug>', 'slug for the imported show')
  .option('--file <path>', 'read the feed from a saved file instead of fetching it')
  .option('--owner-name <name>')
  .option('--owner-email <email>')
  .option('--dry-run', 'write the result locally instead of uploading')
  .option('--out <dir>', 'output directory for --dry-run')
  .option('--force', 'overwrite an existing show')
  .action((url, o) => importCommand(url, o, g()));

program
  .command('validate <fileOrUrl>')
  .description('Validate an RSS feed')
  .action((source) => validate(source));

program
  .command('status <slug>')
  .description('Show status, feed URL and any feed validation errors')
  .action((slug) => showStatus(slug, g()));

program
  .command('rebuild <slug>')
  .description('Rebuild a show feed now')
  .action((slug) => requestRebuild(slug, g()));

const episode = program.command('episode').description('Manage episodes');
episode
  .command('hide <slug> <guid>')
  .description('Remove an episode from the feed')
  .action((slug, guid) => setEpisodeStatus(slug, guid, 'hidden', g()));
episode
  .command('unhide <slug> <guid>')
  .description('Put a hidden episode back in the feed')
  .action((slug, guid) => setEpisodeStatus(slug, guid, 'published', g()));

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
