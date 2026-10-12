#!/usr/bin/env -S npx tsx
import { Command, Option } from 'commander';
import type { GlobalOptions } from './context';
import { listEpisodes, rescheduleEpisode, setEpisodeStatus } from './commands/episode';
import { addDashboardUser, checkAnalytics, runAnalytics } from './commands/analytics';
import { cutover } from './commands/cutover';
import { importCommand } from './commands/import';
import { migrateMedia } from './commands/migrate';
import { bundleStatus, publish } from './commands/publish';
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
  .description('Publish an audio or video file, or a bundle directory with episode.json')
  .requiredOption('--show <slug>')
  .option('--title <title>')
  .option('--description <html>', 'show notes (HTML)')
  .option('--notes <file>', 'read show notes (HTML) from a file')
  .option(
    '--pub-date <when>',
    'release time: "YYYY-MM-DD HH:mm" (local), ISO with a zone, or "now". A future time schedules it.',
  )
  .option('--season <n>')
  .option('--episode <n>')
  .addOption(new Option('--type <type>').choices(['full', 'trailer', 'bonus']))
  .option('--explicit', 'mark as explicit')
  .option('--guid <guid>', 'update an existing episode')
  .option('--transcript <file>', 'VTT, SRT or Podcasting 2.0 JSON')
  .option('--chapters <file>', 'Podcasting 2.0 JSON chapters')
  .option('--cover <file>', 'episode artwork')
  .option('--video <file>', 'video alongside the audio (e.g. an audiogram for YouTube)')
  .option('--no-wait', "don't wait for the publish result")
  .action((path, o) => publish(path, o, g()));

program
  .command('bundle <slug> <bundleId>')
  .description('Show the result of an earlier upload (e.g. after video processing)')
  .action((slug, id) => bundleStatus(slug, id, g()));

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
  .command('migrate-media <slug>')
  .description("Copy an imported show's media from the old host into your bucket")
  .option('--dry-run', 'list what would be copied')
  .option('--concurrency <n>', 'episodes copied at once', '3')
  .action((slug, o) => migrateMedia(slug, o, g()));

program
  .command('cutover <slug>')
  .description('Check, then make an imported show live and verify the public feed')
  .option('--go', 'make the show live (without it, only the checks run)')
  .option('--no-ping', "don't notify Podcast Index")
  .option('--allow-remote-media', 'go live while some media is still on the old host')
  .option('--check-redirect', 'check whether the old feed redirects to the new one')
  .action((slug, o) => cutover(slug, o, g()));

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

program
  .command('episodes <slug>')
  .description('List episodes: live, scheduled or hidden, and the next release')
  .action((slug) => listEpisodes(slug, g()));

const episode = program.command('episode').description('Manage episodes');
episode
  .command('reschedule <slug> <guid>')
  .description('Change when an episode releases ("now" releases it immediately)')
  .requiredOption('--pub-date <when>', '"YYYY-MM-DD HH:mm" (local), ISO with a zone, or "now"')
  .option('--force', 'allow moving an already-released episode into the future')
  .action((slug, guid, o) => rescheduleEpisode(slug, guid, o, g()));
episode
  .command('hide <slug> <guid>')
  .description('Remove an episode from the feed')
  .action((slug, guid) => setEpisodeStatus(slug, guid, 'hidden', g()));
episode
  .command('unhide <slug> <guid>')
  .description('Put a hidden episode back in the feed')
  .action((slug, guid) => setEpisodeStatus(slug, guid, 'published', g()));

const analytics = program.command('analytics').description('Download analytics');
analytics
  .command('run')
  .description('Count downloads now (default: yesterday). Re-running a day is safe.')
  .option('--date <date...>', 'specific UTC days, YYYY-MM-DD')
  .option('--from <date>', 'first day of a range')
  .option('--to <date>', 'last day of a range (default: yesterday)')
  .action((o) => runAnalytics(o, g()));
analytics
  .command('check')
  .description('Check that CloudFront logs are landing and Athena can read them')
  .action(() => checkAnalytics(g()));

program
  .command('dashboard')
  .description('Dashboard access')
  .command('add-user <email>')
  .description('Invite someone to the dashboard (Cognito emails a temporary password)')
  .action((email) => addDashboardUser(email, g()));

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
