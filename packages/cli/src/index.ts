import { Command, Option } from 'commander';
import type { GlobalOptions } from './context';
import { manyBrands, oneBrand } from './brands';
import {
  addOutlet,
  getBrand,
  listBrands,
  migrateBrands,
  putBrand,
  removeOutlet,
  setBrandIcon,
} from './commands/brand';
import {
  coverToThumbnail,
  listEpisodes,
  rescheduleEpisode,
  setEpisodeStatus,
} from './commands/episode';
import { checkAnalytics, runAnalytics } from './commands/analytics';
import {
  ROLES,
  addDashboardUser,
  listDashboardUsers,
  removeDashboardUser,
  setDashboardRole,
} from './commands/dashboard';
import { cutover } from './commands/cutover';
import { importCommand } from './commands/import';
import { migrateMedia } from './commands/migrate';
import { bundleStatus, publish } from './commands/publish';
import { getShow, putShow, requestRebuild, setShowStatus, showStatus } from './commands/show';
import {
  batchStatus,
  listShorts,
  putShorts,
  scheduleShort,
  sweepShorts,
  uploadShortNow,
} from './commands/shorts';
import { validate } from './commands/validate';
import * as youtube from './commands/youtube';
import { OUTLET_KINDS } from '@darkrelay/core';

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
  .command('get <slug>')
  .description("Print a show's current JSON (edit it, then show put it back)")
  .action((slug) => getShow(slug, g()));
show
  .command('go-live <slug>')
  .description('Publish the public feed for a draft show')
  .action((slug) => setShowStatus(slug, 'live', g()));
show
  .command('draft <slug>')
  .description('Stop updating the public feed (the last one stays up)')
  .action((slug) => setShowStatus(slug, 'draft', g()));

const brand = program
  .command('brand')
  .description('Manage brands and the outlets they publish to')
  .addHelpText(
    'after',
    `
A brand is what DarkRelay publishes and measures; its outlets are the places
content goes out (an RSS feed DarkRelay hosts, a YouTube channel, Spotify,
Apple). Content belongs to the brand, not to an outlet. A show is a brand
with one rss outlet, and keeps its slug, feed URL and GUIDs.`,
  );
brand
  .command('list')
  .description('Brands in this deployment and their outlets')
  .action(() => listBrands(g()));
brand
  .command('get <slug>')
  .description("Print a brand's JSON (edit it, then brand put it back)")
  .action((slug) => getBrand(slug, g()));
brand
  .command('put <file>')
  .description('Create or update a brand from a JSON file')
  .option('--icon <path>', 'square brand icon (JPEG or PNG, 128-3000 px, under 2 MB)')
  .action((file, o) => putBrand(file, o, g()));
brand
  .command('icon <slug> <image>')
  .description("Set a brand's icon (square JPEG or PNG, shown in the dashboard)")
  .action((slug, image) => setBrandIcon(slug, image, g()));
brand
  .command('migrate [slug]')
  .description('Write brand.json for existing shows (all of them without a slug)')
  .option('--dry-run', 'list what would be written')
  .option(
    '--force',
    "rewrite an existing brand from its show, losing the brand's own name and icon",
  )
  .action((slug, o) => migrateBrands(slug, o, g()));

const outlet = brand.command('outlet').description("A brand's outlets");
outlet
  .command('add <slug>')
  .description('Add an outlet to a brand, or replace the one with the same --id')
  .addOption(new Option('--kind <kind>', 'outlet kind').choices(OUTLET_KINDS).makeOptionMandatory())
  .option('--id <id>', 'outlet id, unique within the brand (default: the kind)')
  .option('--label <label>', 'name shown for it in the dashboard')
  .option('--connection <name>', 'youtube: a channel from `darkrelay youtube connect`')
  .option('--feed <slug>', 'rss: the feed config to publish through (default: the brand slug)')
  .option('--url <url>', 'spotify, apple: the brand page on that platform')
  .action((slug, o) => addOutlet(slug, o, g()));
outlet
  .command('remove <slug> <id>')
  .description('Stop counting an outlet (nothing is deleted or unpublished)')
  .action((slug, id) => removeOutlet(slug, id, g()));

program
  .command('publish <path>')
  .description('Publish an audio or video file, or a bundle directory with episode.json')
  .option('--brand <slug>', 'the brand to publish to')
  .addOption(new Option('--show <slug>', 'old name of --brand'))
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
  .option('--cover <file>', 'episode artwork for podcast apps (square, 1400-3000 px)')
  .option(
    '--thumbnail <file>',
    'YouTube thumbnail (16:9, 1280x720, under 2 MB); default: the cover',
  )
  .option('--video <file>', 'video alongside the audio (e.g. an audiogram for YouTube)')
  .option('--yt-title <title>', 'YouTube title, if different from the episode title')
  .option(
    '--yt-description <file>',
    'YouTube description (plain text) from a file, instead of the show notes',
  )
  .option('--no-wait', "don't wait for the publish result")
  .action((path, o) => publish(path, { ...o, show: oneBrand(o) }, g()));

program
  .command('bundle <slug> <bundleId>')
  .description('Show the result of an earlier upload (e.g. after video processing)')
  .action((slug, id) => bundleStatus(slug, id, g()));

program
  .command('import <feedUrl>')
  .description('Import an existing feed as a draft show (media stays on the old host)')
  .option('--brand <slug>', 'slug for the imported brand')
  .addOption(new Option('--show <slug>', 'old name of --brand'))
  .option('--file <path>', 'read the feed from a saved file instead of fetching it')
  .option('--owner-name <name>')
  .option('--owner-email <email>')
  .option('--dry-run', 'write the result locally instead of uploading')
  .option('--out <dir>', 'output directory for --dry-run')
  .option('--force', 'overwrite an existing show')
  .action((url, o) => importCommand(url, { ...o, show: oneBrand(o) }, g()));

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
episode
  .command('cover-to-thumbnail <slug> [guid]')
  .description(
    'Use episode artwork only as the YouTube thumbnail, so apps show the show artwork (all episodes without a guid)',
  )
  .option('--dry-run', 'list the episodes it would change')
  .action((slug, guid, o) => coverToThumbnail(slug, guid, o, g()));

const shorts = program
  .command('shorts')
  .description('Videos and Shorts: content that is not an episode')
  .addHelpText(
    'after',
    `
A batch is a directory holding shorts.json and the video files it names.
Uploading one records each Short against the brand; nothing goes to YouTube
until a few days before its slot, as a private video with a publishAt.`,
  );
shorts
  .command('put <dir>')
  .description('Upload a batch of Shorts (a directory with shorts.json)')
  .option('--brand <slug>', 'the brand they belong to')
  .addOption(new Option('--show <slug>', 'old name of --brand'))
  .option('--dry-run', 'list what would be uploaded')
  .option('--no-wait', "don't wait for the ingest result")
  .action((dir, o) => putShorts(dir, o, g()));
shorts
  .command('list <brand>')
  .description("A brand's videos and Shorts, their slots and where each one stands")
  .action((brand) => listShorts(brand, g()));
shorts
  .command('batch <brand> <batchId>')
  .description('The result of an earlier batch upload')
  .action((brand, batchId) => batchStatus(brand, batchId, g()));
shorts
  .command('schedule <brand> <id>')
  .description('Give one a slot, or move it ("now" releases it immediately)')
  .requiredOption('--at <when>', '"YYYY-MM-DD HH:mm" (local), ISO with a zone, or "now"')
  .action((brand, id, o) => scheduleShort(brand, id, o, g()));
shorts
  .command('upload <brand> <id>')
  .description('Upload one now, ahead of its slot')
  .action((brand, id, o) => uploadShortNow(brand, id, o, g()));
shorts
  .command('sweep')
  .description('Run the hourly pass now: upload what is due, move what changed')
  .option('--lead-days <n>', 'how far ahead of its slot to upload')
  .option('--daily-uploads <n>', 'cap per channel per day (quota protection)')
  .action((o) => sweepShorts(o, g()));

const yt = program.command('youtube').description('YouTube uploads and analytics');
yt.command('client')
  .description('Store the Google OAuth client (Desktop app) used for YouTube')
  .option('--file <path>', 'client_secret.json downloaded from Google Cloud Console')
  .option('--client-id <id>')
  .option('--client-secret <secret>')
  .action((o) => youtube.setClient(o, g()));
yt.command('connect <name>')
  .description('Sign in to a YouTube channel and store its token (once per channel)')
  .option('--brand <slug>', "add it as that brand's YouTube outlet, creating the brand if new")
  .action((name, o) => youtube.connect(name, o, g()));
yt.command('backfill <brand>')
  .description("Read a brand's channel history: every upload, and the channel's own numbers")
  .option('--from <date>', 'first day, YYYY-MM-DD (default: a year ago)')
  .option('--to <date>', 'last day (default: yesterday)')
  .action((brand, o) => youtube.backfill(brand, o, g()));
yt.command('status <slug>')
  .description("Each episode's YouTube video or upload progress")
  .action((slug) => youtube.status(slug, g()));
yt.command('link <slug> <guid> <video>')
  .description('Link an episode to a video already on YouTube (id or URL)')
  .action((slug, guid, video) => youtube.link(slug, guid, video, g()));
yt.command('match <slug>')
  .description('Find existing channel uploads for episodes by title or description')
  .option('--apply', 'link the matches')
  .action((slug, o) => youtube.match(slug, o, g()));
yt.command('sync <slug> <guid>')
  .description("Send an episode's title and description to its YouTube video now")
  .option('--force', 'also for a video that was linked rather than uploaded by DarkRelay')
  .action((slug, guid, o) => youtube.syncNow(slug, guid, o, g()));
yt.command('thumbnail <slug> <image> [guids...]')
  .description(
    "Set one image as several episodes' YouTube thumbnail (16:9 JPEG or PNG, under 2 MB)",
  )
  .option('--through <date>', 'every episode released on or before YYYY-MM-DD, instead of guids')
  .option('--dry-run', 'list the videos it would change')
  .action((slug, image, guids, o) => youtube.setThumbnails(slug, image, guids, o, g()));
yt.command('upload <slug> <guid>')
  .description('Upload one episode now')
  .option('--force', 'upload again even if it already has a video')
  .action((slug, guid, o) => youtube.uploadNow(slug, guid, o, g()));

const analytics = program.command('analytics').description('Download analytics');
analytics
  .command('run')
  .description('Count downloads now (default: yesterday). Re-running a day is safe.')
  .option('--date <date...>', 'specific UTC days, YYYY-MM-DD')
  .option('--from <date>', 'first day of a range')
  .option('--to <date>', 'last day of a range (default: yesterday)')
  .option('--source <source>', 'cloudfront (download logs, kept 90 days) or youtube', 'cloudfront')
  .action((o) => runAnalytics(o, g()));
analytics
  .command('check')
  .description('Check that CloudFront logs are landing and Athena can read them')
  .action(() => checkAnalytics(g()));

const dashboard = program
  .command('dashboard')
  .description('Dashboard access')
  .addHelpText(
    'after',
    `
Roles:
  admin      every show: analytics and uploads
  uploader   analytics and uploads for the --show shows
  viewer     analytics only, for the --show shows
  none       remove the --show shows, or with no --show, all access
Users with no role can sign in but see nothing.`,
  );
const roleOption = () =>
  new Option('--role <role>', 'admin, uploader, viewer or none')
    .choices(ROLES)
    .makeOptionMandatory();
dashboard
  .command('add-user <email>')
  .description('Invite someone to the dashboard (Cognito emails a temporary password)')
  .addOption(roleOption())
  .option('--brand <slug...>', 'brands the role applies to (viewer, uploader)')
  .addOption(new Option('--show <slug...>', 'old name of --brand'))
  .action((email, o) => addDashboardUser(email, { ...o, show: manyBrands(o) }, g()));
dashboard
  .command('set-role <email>')
  .description("Change someone's access, e.g. --role uploader --show my-show")
  .addOption(roleOption())
  .option('--brand <slug...>', 'brands the role applies to')
  .addOption(new Option('--show <slug...>', 'old name of --brand'))
  .action((email, o) => setDashboardRole(email, { ...o, show: manyBrands(o) }, g()));
dashboard
  .command('users')
  .description('List dashboard users and their roles')
  .action(() => listDashboardUsers(g()));
dashboard
  .command('remove-user <email>')
  .description('Remove someone from the dashboard')
  .action((email) => removeDashboardUser(email, g()));

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
