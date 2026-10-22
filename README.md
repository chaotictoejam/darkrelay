# DarkRelay

Self-hosted, serverless podcast hosting and analytics on AWS. It is the publishing half of [Darkroom](https://github.com/chaotictoejam/darkroom): Darkroom records, edits and exports; DarkRelay publishes and measures.

One upload in. An RSS feed (iTunes and Podcasting 2.0 tags) out, served from your own AWS account, with your own download logs.

**Status:** phases 1 and 2 (hosting, feeds, import and migration, download analytics, dashboard). Video (phase 3) is built too. YouTube and prefix mode come next; see [Roadmap](#roadmap).

## How it works

```
darkrelay publish ──► S3 inbox/ ──(EventBridge)──► Publisher Lambda ──► S3 public/ ◄── CloudFront ◄── podcast apps
                                                     │ validates bundle               │
                                                     │ writes manifest                └─► access logs (Parquet) ─► S3
                                                     │ rebuilds + validates feed
                                                     └ invalidates feed, pings Podcast Index
```

- **Downloads never touch Lambda, a database or the dashboard.** CloudFront serves media and feeds straight from S3. If anything else breaks, episodes still download.
- **Feeds are static files**, rebuilt on every publish. A feed that fails validation is never written: the last good one stays up and the errors are saved for `darkrelay status`.
- **Several shows per deployment**, each at `https://<your-domain>/<show>/feed.xml`.
- **Scheduled releases**: publish ahead of time with a future `--pub-date`; see below.

## Deploy

Requirements: Node 22+ (npm comes with it), AWS credentials for the target account, and the account [bootstrapped for CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) in us-east-1.

```bash
npm install
cp darkrelay.config.example.json darkrelay.config.json   # then edit it
npm run deploy
```

For stacks that add IAM roles or policies, CDK asks "Do you wish to deploy these changes (y/n)?" and waits. The transcoder image build prints a lot at the same time, so the question is easily lost and the deploy looks stuck; type `y` and press Enter. To avoid the prompts, review the changes first, then deploy without approval:

```bash
npm exec -w @darkrelay/infra -- cdk diff
npm run deploy -- --require-approval never
```

Everything deploys to **us-east-1** (CloudFront certificates and log delivery must live there).

### Config (`darkrelay.config.json`)

| Field | Default | Meaning |
| --- | --- | --- |
| `stackPrefix` | `DarkRelay` | Stack and resource name prefix. Change it to run two deployments. |
| `domain` | none | Omit to use the `*.cloudfront.net` domain. |
| `logs.retentionDays` | `90` | Raw access logs (they contain IP addresses) are deleted after this. |
| `priceClass` | `100` | CloudFront edge coverage. `100` (North America and Europe) is cheapest. |
| `tags` | none | Extra tags on every resource, e.g. `{"CostCenter": "podcast"}`. See [Cost Explorer tags](#cost-explorer-tags). |

**Domain with Route 53** (the zone must be in the same account; DNS records and the certificate are created for you):

```json
{
  "domain": {
    "dns": "route53",
    "name": "media.example.com",
    "hostedZoneName": "example.com"
  }
}
```

Add `"hostedZoneId"` to skip the zone lookup at synth time.

**Domain with DNS elsewhere:** request the certificate once, add the validation record it shows at your DNS provider, then point a CNAME for your domain at the distribution after deploying.

```bash
aws acm request-certificate --region us-east-1 --domain-name media.example.com --validation-method DNS
aws acm describe-certificate --region us-east-1 --certificate-arn <arn>   # shows the record to add
```

```json
{
  "domain": {
    "dns": "external",
    "name": "media.example.com",
    "certificateArn": "arn:aws:acm:us-east-1:..."
  }
}
```

## Use

```bash
# Create a show (copy examples/show.example.json). New shows start as drafts.
npx darkrelay show put my-show.json --image cover.jpg
npx darkrelay show go-live my-show

# Change a show later: fetch its current JSON, edit it, put it back
npx darkrelay show get my-show > my-show.json
npx darkrelay show put my-show.json

# Publish a Darkroom MP3 export
npx darkrelay publish "Episode 12.mp3" --show my-show \
  --title "Episode 12" --notes notes.html --season 2 --episode 12 --transcript ep12.vtt

npx darkrelay status my-show
npx darkrelay validate https://media.example.com/my-show/feed.xml
```

### Scheduled releases

Upload an episode now and have it appear later:

```bash
npx darkrelay publish ep13.mp3 --show my-show --title "Episode 13" --notes notes.html \
  --pub-date "2026-10-20 06:00"            # local time on this machine
npx darkrelay episodes my-show            # live / scheduled / hidden, and the next release
npx darkrelay episode reschedule my-show <guid> --pub-date "2026-10-21 06:00"
npx darkrelay episode reschedule my-show <guid> --pub-date now     # release immediately
```

`--pub-date` takes `"YYYY-MM-DD HH:mm"` in your local time zone, ISO with a zone (`2026-10-20T10:00Z`, `2026-10-20T06:00-04:00`), or `now`. A bare date is refused, because it would silently mean midnight UTC.

How it works: the episode is stored and its media uploaded right away, but it stays out of the feed until its time. Every feed rebuild sets a one-shot EventBridge Scheduler job for the show's next release (5 seconds after it), which rebuilds the feed, invalidates the CDN copy and pings Podcast Index. The hourly sweep is a backup if a schedule is ever missed. Before release, the media is only reachable by its unlisted URL, which appears nowhere until the feed lists it. Moving an already-released episode into the future would pull it from the feed, so `reschedule` asks for `--force`. Scheduler is free at this volume (14 million invocations a month).

`publish` saves `<file>.episode.json` next to the audio. Publishing the same file again updates the episode instead of creating a new one. An update replaces the files its bundle contains and keeps the rest (artwork, transcripts, chapters, video), and a bundle for an existing episode may leave out the audio to change only its details or other files. Run `npx darkrelay --help` for every command.

### Episode bundles

`publish` also takes a directory, which is the format Darkroom will export directly:

| File | Required | Notes |
| --- | --- | --- |
| `episode.json` | yes | Title, notes, dates, `status` (`hidden` or `published`), and optionally YouTube's own title and description. Schema: `packages/core/src/bundle.ts` |
| `audio.mp3` or `audio.m4a` | yes, for a new episode | WAV and FLAC are rejected: export MP3 for feeds. |
| `transcript.vtt` / `.srt` / `.json` | no | Each one becomes a `<podcast:transcript>`. |
| `chapters.json` | no | Podcasting 2.0 JSON chapters. |
| `cover.jpg` / `cover.png` | no | Episode artwork. |
| `video.mp4` | no | Stored for the video pipeline (phase 3). |

## Moving a show from another host

Migration is three steps, and only the last one is visible to listeners. Coming from Spotify for Creators (Anchor)? Follow the step-by-step guide in [docs/migrating-from-spotify.md](docs/migrating-from-spotify.md).

1. **Import** (available now). Copies show and episode details into a draft show. Media stays on the old host; nothing public changes.

   ```bash
   npx darkrelay import https://anchor.fm/s/xxxx/podcast/rss --show my-show --dry-run   # look first
   npx darkrelay import https://anchor.fm/s/xxxx/podcast/rss --show my-show
   ```

   Every episode `<guid>` is kept exactly. The show's `podcast:guid` is kept, or if the old feed never declared one, derived from the **old** feed URL as the Podcasting 2.0 spec requires. Changing either makes apps show duplicates.

2. **Migrate media** (available now). Copies audio, episode artwork, transcripts and chapters from the old host into your bucket, then rebuilds the feed to point at the copies.

   ```bash
   npx darkrelay migrate-media my-show --dry-run   # list what would be copied
   npx darkrelay migrate-media my-show
   ```

   Downloads follow redirects (such as Spotify's `anchor.fm/.../play/...` links) and stream straight to S3. Each audio file's size is checked against the `length` in the feed; an episode with a mismatch or a failed download keeps pointing at the old host. Re-run to retry: finished episodes are skipped. Original URLs are kept in each manifest under `migratedFrom`. Behind an HTTP proxy, set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses `HTTPS_PROXY`.

3. **Cut over** (available now).

   ```bash
   npx darkrelay cutover my-show          # preflight only: changes nothing
   npx darkrelay cutover my-show --go     # make the feed public, verify it, ping Podcast Index
   npx darkrelay cutover my-show --check-redirect
   ```

   The preflight blocks on media still on the old host, a locked source feed, a new feed that fails validation, a changed `podcast:guid`, or any old episode GUID missing from the new feed. After `--go`, set the old host to redirect its feed (301) to the new URL and keep the old account for a few weeks. `--check-redirect` confirms the old feed answers with a 301 or an `<itunes:new-feed-url>` pointing at yours.

## Video

Each show chooses how it treats video with `video.hls` in its show file:

| Show type | Upload | What happens |
| --- | --- | --- |
| Audio-first, e.g. an audiogram (`hls: false`, the default) | `ep.mp3 --video audiogram.mp4` | Publishes at once. The MP3 is the feed enclosure; the video is stored untouched for YouTube. |
| Video show (`hls: true`) | `ep.mp4` | ffmpeg on Fargate extracts a 128 kbps MP3 for the feed and builds HLS (1080p/720p/480p, never upscaled), listed as `<podcast:alternateEnclosure type="application/x-mpegURL">`. The episode publishes when that finishes. |

A video-only upload on an audio-first show still works: the audio is extracted, no HLS is built.

```bash
npx darkrelay publish episode.mp4 --show my-show --title "..." --notes notes.html
npx darkrelay bundle my-show <bundleId>   # check on it later
```

How it runs: the publisher starts one Fargate Spot task per upload (4 vCPU, 8 GB, 60 GB scratch; configurable under `transcoder` in `darkrelay.config.json`). Tasks run in public subnets with a public IP, so there's no NAT gateway; S3 traffic uses a free gateway endpoint. The task writes the audio and HLS, then `processed.json`, which resumes publishing. If Spot reclaims the task, the publisher retries once on regular Fargate; a second failure rejects the bundle with the reason. Uploads over 5 GB are copied with multipart copy.

`cdk deploy` builds the transcoder image (Debian's ffmpeg, about 1 GB), so the machine you deploy from needs Docker or Podman. For Podman, set `CDK_DOCKER=podman` (e.g. `CDK_DOCKER=podman npm run deploy`). Nothing else needs a container build: the Lambdas are bundled with the local esbuild.

Apps that support `alternateEnclosure` (Fountain, Podverse and a few others) offer the video. Apple Podcasts and Spotify ignore it and play the audio.

## YouTube

Each show can upload its episode videos to a YouTube channel and pull views, watch time and retention back into the dashboard.

**Setup.** Follow [docs/connecting-youtube.md](docs/connecting-youtube.md) to create the Google Cloud project and OAuth client, connect each channel, and add `youtube` to the show file.

**Uploads.** When an episode with a video publishes (a full video or an audiogram), it uploads to YouTube with the title, show notes as plain text, chapters as description timestamps, captions from the transcript, the episode art as thumbnail, and the playlist. A scheduled episode uploads right away as private with YouTube's `publishAt`, and moves if you reschedule the episode. Uploads resume across Lambda invocations, so long videos are fine. `npx darkrelay youtube status <show>` shows each episode's video, progress or error.

**YouTube's own title and description.** By default the video gets the episode title and the show notes. To write them for YouTube instead (a title for search, a plain-text description with timestamps and hashtags), add them to `publish`:

```bash
npx darkrelay publish ep.mp3 --show my-show --title "blame: the feed title" --notes notes.html \
  --video audiogram.mp4 --yt-title "Bus Factor: The Search Title" --yt-description youtube.txt
```

In a bundle, put them in `episode.json` as `"youtube": { "title": "...", "description": "..." }`. Either can be left out, and the feed's is used for that one. They're checked against YouTube's limits (title 100 characters, description 5000 bytes, no `<` or `>`) before anything uploads. If the description already has its own timestamps starting at `0:00`, chapters from `chapters.json` aren't added again. A republish keeps them unless you pass new ones; `"youtube": {}` in `episode.json` goes back to the feed's.

**Keeping the video in step.** When you republish an episode whose video DarkRelay uploaded, a changed title, description or tags update the video on YouTube; an unchanged republish makes no API call. That update replaces edits made in YouTube Studio, so change a video's title and description with `--yt-title`/`--yt-description` rather than in Studio. Videos uploaded before this was added keep their current YouTube copy until the episode gets copy of its own. Linked videos (below) are never changed, unless you ask:

```bash
npx darkrelay youtube sync my-show <guid>           # send the title and description now
npx darkrelay youtube sync my-show <guid> --force   # also for a linked video
```

**Two YouTube rules to know:**

- **New Google Cloud projects can only upload private videos** until they pass YouTube's API compliance audit (free; request it from the YouTube API Services audit form). Until then, make each upload public in YouTube Studio. DarkRelay detects this and says so in `youtube status`.
- **Quota:** the default allowance covers several uploads a day, which is plenty for a podcast.

**Episodes already on YouTube:** link them, then backfill their analytics.

```bash
npx darkrelay youtube match my-show           # pairs episodes and uploads by title, or by the episode title in the description
npx darkrelay youtube match my-show --apply
npx darkrelay youtube link my-show <guid> https://youtu.be/<id>   # one at a time
npx darkrelay analytics run --source youtube --from 2026-04-01
```

**Analytics.** Nightly at 04:40 UTC, views and watch time per episode per day (re-reading the last week, as YouTube finalises numbers a few days late) and each recent video's retention curve. Views count as plays alongside podcast downloads, and the dashboard's _By source_ table keeps them apart.

## Analytics

Downloads are counted once a night from CloudFront's own logs, so nothing extra runs when someone downloads an episode.

```
CloudFront logs (Parquet, hourly) ─► S3 ─► Athena, 03:20 UTC ─► aggregator Lambda ─► DynamoDB ◄── dashboard API ◄── dashboard
```

**How a download is counted** (IAB v2.2 style):

- Only `GET` requests for episode audio with status 200 or 206.
- Requests are grouped by file + IP address + User-Agent per UTC day, with byte ranges summed. A group counts once, and only if it fetched at least one minute of audio (the file's bitrate times 60 s, or the whole file if shorter). Apple's 2-byte probe requests never count.
- Bots are removed using the [OPAWG user-agent lists](https://github.com/opawg/user-agents-v2) (vendored at a pinned commit; refresh with `node scripts/update-opawg.mjs <commit>`). Apps and devices come from the same lists.
- Self-hosted servers (audiobookshelf, Pinepods, Podgrab, Podcast Archiver) download on a schedule, not when someone listens. They are counted separately as "downloads, not listens".
- Country comes from CloudFront's `c-country` log field. IP addresses are grouped on inside Athena and never leave it.

Each nightly run covers yesterday and the day before (CloudFront logs can arrive late). Re-running a day overwrites it, so counts never double.

```bash
npx darkrelay analytics check                     # after the first deploy: are logs readable?
npx darkrelay analytics run                       # count yesterday now
npx darkrelay analytics run --from 2026-10-01     # backfill (raw logs are kept 90 days)
```

### Dashboard access

The dashboard signs people in with Cognito (no self sign-up). What each person sees and does is set per show:

| Role                  | Can                                                    |
| --------------------- | ------------------------------------------------------ |
| `admin`               | Every show: analytics and uploads                      |
| `uploader` (per show) | Analytics for that show, and upload new episodes to it |
| `viewer` (per show)   | Analytics for that show                                |
| no role               | Sign in, but see nothing                               |

```bash
npx darkrelay dashboard add-user you@example.com --role admin       # Cognito emails a temporary password
npx darkrelay dashboard add-user host@example.com --role uploader --show my-show other-show
npx darkrelay dashboard set-role host@example.com --role viewer --show other-show  # replaces their role for that show
npx darkrelay dashboard set-role host@example.com --role none --show other-show    # removes that show
npx darkrelay dashboard set-role host@example.com --role none                      # removes all access
npx darkrelay dashboard users                                        # everyone and their roles
npx darkrelay dashboard remove-user host@example.com
```

Roles are Cognito groups (`admin`, `uploader:<show>`, `viewer:<show>`) carried in the sign-in token, so a change applies at the person's next sign-in, or within the hour. The API checks them on every request; hiding a button in the UI is not the protection.

Users created before roles existed have no role and see nothing. Delete them with `remove-user` and add them again with a role (or give them one with `set-role`).

### Uploading from the dashboard

Uploaders and admins get an **Upload episode** page: show, title, show notes (HTML), release time (now, or a date and time in the browser's time zone), season, episode number, type, explicit, and files (audio or a video episode, plus optional transcript, chapters, artwork and an audiogram video). It produces the same bundle as `darkrelay publish`, so publishing, video processing and YouTube uploads work the same way, and the page follows the result through to published, scheduled or rejected.

The browser sends the files straight to S3 as multipart uploads, so multi-GB videos are fine and nothing needs AWS credentials. The API hands out presigned URLs for one part at a time (valid 15 minutes, only for that bundle's files under `inbox/<show>/<bundleId>/`), failed parts are retried, and **Retry** resumes from the parts already sent. The API writes `episode.json` itself, last, after checking it against the bundle schema. The episode length is read in the browser; if it can't read the file, the page asks for it.

**Editing episodes.** _Manage episodes_ on a show's page lists every episode, including scheduled and hidden ones. Editing one changes its details, release time or visibility, and can replace any of its files (audio, transcript, chapters, artwork, audiogram) without re-uploading the rest. Moving an episode that is already out back into the future asks for confirmation first, as `episode reschedule --force` does. A new audio file doesn't re-upload the YouTube video; the title and description still sync to it. Edits go through the publisher as a bundle, like everything else, so the dashboard API never writes outside `inbox/`.

To run the download or YouTube pulls yourself (catch up, backfill, or check the logs are readable), see [docs/running-analytics.md](docs/running-analytics.md).

**Adding a data source** (YouTube, CSV imports, prefix redirects) means writing daily items in the shape defined in `packages/core/src/analytics/metrics.ts` with a new `source`. The dashboard sums all sources and needs no changes.

## Cost

Personal scale (a few shows, a few thousand downloads a month) runs about **$1-4/month**:

- Route 53 hosted zone: $0.50/month, if you use one
- S3 storage: about $0.023/GB-month (100 one-hour MP3 episodes is about 6 GB)
- CloudFront: the first 1 TB/month of transfer is free
- Access logs: about $0.25/GB delivered plus $0.035/GB for Parquet. Cents per month.
- Lambda, EventBridge, CloudWatch Logs, Cognito (Lite, under 10,000 users), API Gateway (HTTP API): within the free tier at this volume
- Video, per hour-long episode: about $0.05-0.10 of Fargate Spot time and about $0.05/month to store the HLS renditions. **Watching is the cost to watch:** an hour of 1080p is 2-3 GB per viewer, and past CloudFront's free 1 TB/month that's about $0.085/GB. Audio-only shows pay none of this.
- ECR: about $0.04/month for the transcoder image
- Athena: $5/TB scanned with a 10 MB minimum per query, so about $0.0001 a night. The workgroup refuses any query over 1 GB.
- DynamoDB on-demand with point-in-time recovery: pennies a month

No NAT gateways, OpenSearch, QuickSight, Kinesis or CloudFront real-time logs, by design.

### Cost alerts

Traffic is the only thing that can make the bill grow fast, so `alerts` in `darkrelay.config.json` deploys two email alerts:

- **Spike alarm** (CloudWatch, $0.10/month): more than `hourlyTransferGB` (default 20 GB) served by DarkRelay's media distribution in one hour. It fires within about an hour and counts only DarkRelay traffic. Confirm the subscription from the first email AWS sends, or nothing arrives.
- **Spend budget** (AWS Budgets, free): CloudFront spend passing each of `monthlyUsd` (default $25, $100, $500), plus a warning when the month is forecast to pass the first. Budgets that only notify are free however many the account has; AWS only charges for budgets with actions. Billing data lags by several hours, and the budget counts every CloudFront distribution in the account.

### Cost Explorer tags

Every resource is tagged `Project=DarkRelay` and `Deployment=<stackPrefix>`, plus anything in `tags` in `darkrelay.config.json`. Transcoder tasks inherit the tags from their task definition, so Fargate time is counted too. To use them in Cost Explorer, activate the keys once (they appear about a day after the first deploy):

```bash
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active TagKey=Deployment,Status=Active
```

or under **Billing and Cost Management → Cost allocation tags**. Costs from before activation aren't tagged, and resources DarkRelay doesn't create (such as an existing Route 53 hosted zone) aren't either.

## Development

```bash
npm test             # all packages
npm run typecheck
npm run format
npm run synth        # needs darkrelay.config.json (or DARKRELAY_CONFIG=path)
```

| Package | What |
| --- | --- |
| `packages/core` | Feed builder, parser, validator, importer, bundle schema, S3 layout. Pure TS. |
| `packages/functions` | Lambda handlers (bundled with esbuild by CDK). |
| `packages/cli` | The `darkrelay` command. |
| `packages/infra` | CDK app: `HostingStack` (S3, CloudFront, DNS, logs) and `PublishStack`. |

### Bucket layout

| Prefix | Public | What |
| --- | --- | --- |
| `public/` | yes | Feeds and media. CloudFront's origin path, so `public/` is dropped from URLs. |
| `catalog/` | no | `show.json`, episode manifests, draft preview feeds, feed errors. The source of truth. |
| `inbox/` | no | Uploaded bundles waiting to publish. Expire after 7 days. |
| `inbox-status/` | no | Publish results the CLI reads. |
| `requests/` | no | Rebuild requests. |

## Roadmap

1. **Hosting core and feed import** (done)
2. **Download analytics and dashboard** (done)
3. **Video: ffmpeg on Fargate Spot to HLS, plus audio extraction** (done)
4. **YouTube upload and analytics** (done)
5. HLS retention curves
6. Prefix mode: analytics for shows that stay on another host
7. Apple and Spotify CSV imports

Further out:

- **Video feed for Apple Podcasts.** Apple's HLS video is only open to partner hosts through a private API, and Apple ignores `podcast:alternateEnclosure`. Self-hosted video can reach Apple Podcasts only as a separate video-only feed with MP4 enclosures (a second listing, like This Week in Tech). This would need an MP4 rendition from the transcoder and a second feed per show.
