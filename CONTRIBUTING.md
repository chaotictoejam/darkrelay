# Contributing to DarkRelay

Thanks for wanting to help. DarkRelay is small, opinionated and run by one person, so a short conversation before a big change saves everyone time.

## Before you start

- **Small fixes** (typos, docs, a clear bug with a test): open a pull request.
- **Anything bigger** (a new outlet, a new stack, a change to the bucket layout or the feed): open an issue first and say what you want to build and why.
- Issues labelled [`good first issue`](https://github.com/chaotictoejam/darkrelay/labels/good%20first%20issue) are scoped to be picked up without much context.
- **Using an AI coding tool? Read [Using AI tools](#using-ai-tools) first.** They're welcome, disclosure isn't optional.

## Principles

These decide most design questions, so please read them before proposing a change:

- **Downloads never depend on anything but S3 and CloudFront.** No Lambda, database or dashboard in the download path.
- **Your account, your data.** No shared DarkRelay service, and nothing sent to a third party that the user did not connect themselves.
- **Cheap by default.** Personal scale should stay at a few dollars a month. No NAT gateways, OpenSearch, QuickSight, Kinesis or real-time logs.
- **Feeds are never published broken.** A feed that fails validation is not written; the last good one stays up.
- **Never break a listener.** Feed URLs, `podcast:guid` and episode `<guid>`s do not change once public.

## Setup

Requirements: Node 22+ and npm 10+. Docker or Podman only if you build the transcoder image. You do **not** need an AWS account to run the tests.

```bash
npm ci
npm run typecheck
npm test
npm run format:check
```

To check the CDK app without deploying, copy `darkrelay.config.example.json` to `darkrelay.config.json` and run `npm run synth`.

## Repo layout

| Package | What |
| --- | --- |
| `packages/core` | Feed builder, parser, validator, importer, bundle schema, S3 layout. Pure TypeScript, no AWS calls. |
| `packages/functions` | Lambda handlers. |
| `packages/cli` | The `darkrelay` command. |
| `packages/dashboard` | The dashboard (Vite). |
| `packages/transcoder` | ffmpeg on Fargate for video and HLS. |
| `packages/infra` | The CDK app. |

## Pull requests

- Work on a branch, one logical change per pull request.
- Add or update tests for behaviour changes. Tests sit in each package's `test/` folder and run with Vitest.
- Run `npm run format` before you push. CI runs format, typecheck, tests, feed validation, the dashboard build, `cdk synth` and the transcoder image build.
- Update the README or `docs/` when you change a command, a config field or what something costs.
- The bundle format in `packages/core/src/bundle.ts` is shared with [Darkroom](https://github.com/chaotictoejam/darkroom). If you change it, say so in the pull request so Darkroom's exporter can follow.

## Using AI tools

AI coding tools are welcome here — DarkRelay is partly built with them — but their use must be disclosed, and you are responsible for what you submit.

- **Say so in the pull request.** If an AI tool wrote or substantially shaped any of the code, tests, docs or the PR description, name the tool and what it did in the **AI use** section of the pull request template. A `Co-Authored-By` trailer in the commits is fine too.
- **You own what you submit.** Read, run and understand every line before you open the pull request, and be ready to explain it in review. "The AI wrote it" isn't an answer to a review question.
- **Run the checks yourself.** Don't take a tool's word that tests pass. CI runs format, typecheck, tests, feed validation, the dashboard build, `cdk synth` and the transcoder image build; run what you can locally first.
- **Review comments count too.** Disclose an AI-written review comment the same way, and read the code before you comment on it — an AI summary of a diff is not a review. Issues are the exception: write a bug report or feature request however you like, with whatever tool you like.

The [Principles](#principles) are where generated code goes wrong most often. A tool with no memory of this repo will happily regenerate a `podcast:guid`, rename a feed URL, publish a feed that fails validation, or reach for a service that costs more than everything else here put together. Any of those breaks a real listener's subscription or someone's bill, and none of it shows up in a diff that looks plausible. Check your change against the principles before you open the pull request.

**Pull requests with undisclosed AI use will be closed without review.** If it's discovered after merge, the change may be reverted. Disclosing doesn't count against you: an honest "Claude Code wrote the tests, I wrote the fix" is exactly what we want to see.

## If you're here for a bounty

Same bar as everyone else, plus a few things that save us both time:

- **Comment on the issue before you start**, and check whether someone already has. Two PRs for one issue means one of them was wasted work.
- **One issue per pull request.** A PR that touches files the issue never mentions will be closed, however good the extra changes are.
- **A pull request that doesn't run gets closed, not reviewed.** Volume isn't value here, and review time is the scarcest thing this project has.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
