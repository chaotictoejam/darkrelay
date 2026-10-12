# DarkRelay

Self-hosted, serverless podcast hosting and analytics on AWS. It is the publishing half of
[DarkRoom](https://github.com/chaotictoejam/darkroom): DarkRoom records, edits and exports; DarkRelay
publishes and measures.

One upload in. An RSS feed (iTunes and Podcasting 2.0 tags) out, served from your own AWS account,
with your own download logs.

**Status:** phase 1 (hosting, feeds, import). Analytics, video, YouTube and prefix mode come next;
see [Roadmap](#roadmap).

## How it works

```
darkrelay publish ──► S3 inbox/ ──(EventBridge)──► Publisher Lambda ──► S3 public/ ◄── CloudFront ◄── podcast apps
                                                     │ validates bundle               │
                                                     │ writes manifest                └─► access logs (Parquet) ─► S3
                                                     │ rebuilds + validates feed
                                                     └ invalidates feed, pings Podcast Index
```

- **Downloads never touch Lambda, a database or the dashboard.** CloudFront serves media and feeds
  straight from S3. If anything else breaks, episodes still download.
- **Feeds are static files**, rebuilt on every publish. A feed that fails validation is never
  written: the last good one stays up and the errors are saved for `darkrelay status`.
- **Several shows per deployment**, each at `https://<your-domain>/<show>/feed.xml`.
- **Scheduled episodes**: a future `--pub-date` holds the episode; an hourly sweep adds it to the
  feed once the time passes. Unchanged feeds are not rewritten.

## Deploy

Requirements: Node 22+, pnpm 10, AWS credentials for the target account, and the account
[bootstrapped for CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) in us-east-1.

```bash
pnpm install
cp darkrelay.config.example.json darkrelay.config.json   # then edit it
pnpm run deploy   # `pnpm deploy` is a built-in pnpm command, so use `run`
```

Everything deploys to **us-east-1** (CloudFront certificates and log delivery must live there).

### Config (`darkrelay.config.json`)

| Field                | Default     | Meaning                                                                 |
| -------------------- | ----------- | ----------------------------------------------------------------------- |
| `stackPrefix`        | `DarkRelay` | Stack and resource name prefix. Change it to run two deployments.       |
| `domain`             | none        | Omit to use the `*.cloudfront.net` domain.                              |
| `logs.retentionDays` | `90`        | Raw access logs (they contain IP addresses) are deleted after this.     |
| `priceClass`         | `100`       | CloudFront edge coverage. `100` (North America and Europe) is cheapest. |

**Domain with Route 53** (the zone must be in the same account; DNS records and the certificate
are created for you):

```json
{ "domain": { "dns": "route53", "name": "media.example.com", "hostedZoneName": "example.com" } }
```

Add `"hostedZoneId"` to skip the zone lookup at synth time.

**Domain with DNS elsewhere:** request the certificate once, add the validation record it shows at
your DNS provider, then point a CNAME for your domain at the distribution after deploying.

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
pnpm darkrelay show put my-show.json --image cover.jpg
pnpm darkrelay show go-live my-show

# Publish a DarkRoom MP3 export
pnpm darkrelay publish "Episode 12.mp3" --show my-show \
  --title "Episode 12" --notes notes.html --season 2 --episode 12 --transcript ep12.vtt

pnpm darkrelay status my-show
pnpm darkrelay validate https://media.example.com/my-show/feed.xml
```

`publish` saves `<file>.episode.json` next to the audio. Publishing the same file again updates the
episode instead of creating a new one. Run `pnpm darkrelay --help` for every command.

### Episode bundles

`publish` also takes a directory, which is the format DarkRoom will export directly:

| File                                | Required | Notes                                                      |
| ----------------------------------- | -------- | ---------------------------------------------------------- |
| `episode.json`                      | yes      | Title, notes, dates. Schema: `packages/core/src/bundle.ts` |
| `audio.mp3` or `audio.m4a`          | yes      | WAV and FLAC are rejected: export MP3 for feeds.           |
| `transcript.vtt` / `.srt` / `.json` | no       | Each one becomes a `<podcast:transcript>`.                 |
| `chapters.json`                     | no       | Podcasting 2.0 JSON chapters.                              |
| `cover.jpg` / `cover.png`           | no       | Episode artwork.                                           |
| `video.mp4`                         | no       | Stored for the video pipeline (phase 3).                   |

## Moving a show from another host

Migration is three steps, and only the last one is visible to listeners.

1. **Import** (available now). Copies show and episode details into a draft show. Media stays on
   the old host; nothing public changes.

   ```bash
   pnpm darkrelay import https://anchor.fm/s/xxxx/podcast/rss --show my-show --dry-run   # look first
   pnpm darkrelay import https://anchor.fm/s/xxxx/podcast/rss --show my-show
   ```

   Every episode `<guid>` is kept exactly. The show's `podcast:guid` is kept, or if the old feed
   never declared one, derived from the **old** feed URL as the Podcasting 2.0 spec requires.
   Changing either makes apps show duplicates.

2. **Migrate media** (available now). Copies audio, episode artwork, transcripts and chapters
   from the old host into your bucket, then rebuilds the feed to point at the copies.

   ```bash
   pnpm darkrelay migrate-media my-show --dry-run   # list what would be copied
   pnpm darkrelay migrate-media my-show
   ```

   Downloads follow redirects (such as Spotify's `anchor.fm/.../play/...` links) and stream
   straight to S3. Each audio file's size is checked against the `length` in the feed; an episode
   with a mismatch or a failed download keeps pointing at the old host. Re-run to retry: finished
   episodes are skipped. Original URLs are kept in each manifest under `migratedFrom`. Behind an
   HTTP proxy, set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses `HTTPS_PROXY`.

3. **Cut over** (next). Go live, then set the old host to redirect its feed (301, and
   `<itunes:new-feed-url>` on the old feed). If the old feed is `<podcast:locked>yes`, unlock it
   at the old host first.

## Cost

Personal scale (a few shows, a few thousand downloads a month) runs about **$1-4/month**:

- Route 53 hosted zone: $0.50/month, if you use one
- S3 storage: about $0.023/GB-month (100 one-hour MP3 episodes is about 6 GB)
- CloudFront: the first 1 TB/month of transfer is free
- Access logs: about $0.25/GB delivered plus $0.035/GB for Parquet. Cents per month.
- Lambda, EventBridge, CloudWatch Logs: within the free tier at this volume

No NAT gateways, OpenSearch, QuickSight, Kinesis or CloudFront real-time logs, by design.

## Development

```bash
pnpm test          # all packages
pnpm typecheck
pnpm format
pnpm synth         # needs darkrelay.config.json (or DARKRELAY_CONFIG=path)
```

| Package              | What                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `packages/core`      | Feed builder, parser, validator, importer, bundle schema, S3 layout. Pure TS. |
| `packages/functions` | Lambda handlers (bundled with esbuild by CDK).                                |
| `packages/cli`       | The `darkrelay` command.                                                      |
| `packages/infra`     | CDK app: `HostingStack` (S3, CloudFront, DNS, logs) and `PublishStack`.       |

### Bucket layout

| Prefix          | Public | What                                                                                   |
| --------------- | ------ | -------------------------------------------------------------------------------------- |
| `public/`       | yes    | Feeds and media. CloudFront's origin path, so `public/` is dropped from URLs.          |
| `catalog/`      | no     | `show.json`, episode manifests, draft preview feeds, feed errors. The source of truth. |
| `inbox/`        | no     | Uploaded bundles waiting to publish. Expire after 7 days.                              |
| `inbox-status/` | no     | Publish results the CLI reads.                                                         |
| `requests/`     | no     | Rebuild requests.                                                                      |

## Roadmap

1. **Hosting core and feed import** (this release)
2. Download analytics (IAB-style counting from CloudFront logs) and a dashboard
3. Video: ffmpeg on Fargate Spot to HLS, plus audio extraction
4. YouTube upload and analytics
5. HLS retention curves
6. Prefix mode: analytics for shows that stay on another host
7. Apple and Spotify CSV imports
