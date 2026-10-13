# Running analytics by hand

DarkRelay collects analytics on its own every night. This guide covers running those jobs yourself: to see today's numbers sooner, backfill past days, or recover from a failed night.

Throughout, replace `<show>` with your show's slug, and dates are `YYYY-MM-DD` in UTC.

## What runs on its own

| Source | When (UTC) | What it covers |
| --- | --- | --- |
| Podcast downloads | 03:20 | Yesterday and the day before, counted from CloudFront's logs (logs can arrive late). |
| YouTube views and watch time | 04:40 | The last 7 days, since YouTube revises a day's numbers for two to three days, plus retention curves for videos published in the last year. |

A manual run does exactly the same work as the nightly job, for the days you choose. Re-running a day replaces its numbers, so nothing is ever counted twice.

## Podcast downloads

```bash
npx darkrelay analytics run                                    # yesterday (the default)
npx darkrelay analytics run --date 2026-10-10                  # one day
npx darkrelay analytics run --date 2026-10-08 2026-10-10       # several days
npx darkrelay analytics run --from 2026-09-01                  # a range, through yesterday
npx darkrelay analytics run --from 2026-09-01 --to 2026-09-30  # a closed range
```

Each day prints a line with its listener groups, episodes and how many requests were filtered out (bots, probes, too-short downloads).

- **Raw logs are kept 90 days.** You can backfill as far back as that, but no further.
- **Today isn't complete.** Running for today counts only the logs delivered so far; the nightly job will recount it.
- Long ranges run five days at a time, so a big backfill takes a few minutes.

## YouTube

```bash
npx darkrelay analytics run --source youtube                                    # yesterday
npx darkrelay analytics run --source youtube --date 2026-10-10                  # one day
npx darkrelay analytics run --source youtube --from 2026-09-01                  # through yesterday
npx darkrelay analytics run --source youtube --from 2026-09-01 --to 2026-09-30
```

It prints a summary per show: how many linked videos it read and how many days had data.

- **Only linked videos are pulled.** The show file needs a `youtube` block (see [Connecting a show to YouTube](connecting-youtube.md)), and each episode needs a video: one DarkRelay uploaded, or one you linked with `youtube link` or `youtube match --apply`.
- **Recent days come in low.** YouTube finalises a day's numbers a few days later. The nightly job re-reads the last week, so these fill in on their own.
- **Backfilling older episodes:** after linking videos that were already on YouTube, pull from around when the first one went up. YouTube keeps the history, so there's no 90-day limit here.

## Checking it works

After your first deploy, or if download counts stay at zero:

```bash
npx darkrelay analytics check
```

It lists the newest CloudFront log files and asks Athena to read them, then reports how many requests it found and over which days. "No logs yet" right after a deploy is normal: download an episode, wait a few minutes, and run it again.

For YouTube, `npx darkrelay youtube status <show>` shows which episodes have a linked video.

## Limits

- At most 400 days per `analytics run`. Split longer backfills into several runs.
- Runs need AWS credentials for the account DarkRelay is deployed in, the same as `cdk deploy`.
