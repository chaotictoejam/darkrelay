# Contributing to DarkRelay

Thanks for wanting to help. DarkRelay is small, opinionated and run by one person, so a short conversation before a big change saves everyone time.

## Before you start

- **Small fixes** (typos, docs, a clear bug with a test): open a pull request.
- **Anything bigger** (a new outlet, a new stack, a change to the bucket layout or the feed): open an issue first and say what you want to build and why.
- Issues labelled [`good first issue`](https://github.com/chaotictoejam/darkrelay/labels/good%20first%20issue) are scoped to be picked up without much context.

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

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
