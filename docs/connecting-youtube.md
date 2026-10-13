# Connecting a show to YouTube

This guide connects a DarkRelay show to a YouTube channel so episode videos upload automatically and views, watch time and retention flow back into the dashboard. You do steps 1 and 2 once per deployment, and steps 3 and 4 once per channel. Steps 5 and 6 are only for shows whose episodes are already on YouTube.

Throughout, replace:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<show>` | The show's slug in DarkRelay | `my-show` |
| `<connection>` | A name you choose for the YouTube channel (lowercase letters, digits and hyphens, up to 40 characters) | `my-channel` |
| `<playlist>` | Optional: the ID of a playlist on that channel to add each upload to | `PLxxxxxxxxxxx` |

## 1. Create a Google Cloud project

In [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the _YouTube Data API v3_ and _YouTube Analytics API_, configure the OAuth consent screen (External), then **publish it ("In production")**. In "Testing", Google expires the tokens every 7 days.

Publishing requires a home page, privacy policy and terms of service on the consent screen's **Branding** page. Use your own email as the user support and developer contact email: the app is yours, used only by you. Host the three pages on a domain you own and add that domain under **Authorized domains**. DarkRelay's [privacy policy](https://darkrelay.chaotictoejam.com/privacy) and [terms](https://darkrelay.chaotictoejam.com/terms) are written for exactly this setup, so you can copy them as they are. Don't upload a logo unless you plan to go through Google's app verification: a logo makes verification mandatory. Until the app is verified, Google shows a "Google hasn't verified this app" screen when you connect; choose **Advanced**, then **Go to** your app.

## 2. Create an OAuth client

Create an OAuth client of type **Desktop app** and download its JSON into `secrets/` in the repo (git ignores that folder). Then store it:

```bash
npx darkrelay youtube client --file secrets/client_secret_*.json
```

## 3. Connect the channel

This opens a Google sign-in. If the account manages several channels, Google asks which one:

```bash
npx darkrelay youtube connect <connection>
```

Repeat with a different `<connection>` for each channel. Several shows can share one connection if they upload to the same channel.

Secrets are SSM Parameter Store SecureStrings under `/darkrelay/`; nothing is stored in the repo.

## 4. Add YouTube to the show file

Fetch the show's current file, add a `youtube` block to it, and put it back:

```bash
npx darkrelay show get <show> > <show>.json
# edit <show>.json
npx darkrelay show put <show>.json
```

The block:

```json
"youtube": {
    "connection": "<connection>",
    "categoryId": "27",
    "playlistId": "<playlist>"
}
```

Options: `upload` (default `true`), `privacy` (`public`, `unlisted`, `private`), `categoryId` (22 People & Blogs, 27 Education, 28 Science & Technology), `playlistId`, `tags`, `descriptionFooter`.

## 5. Link episodes already on YouTube

Skip this for a new show. If you imported a show whose episodes are already on the channel, link each episode to its existing video so its views count. Linking only records the video ID: nothing is uploaded, and the video's privacy and schedule are left alone.

Preview the matches first. This changes nothing:

```bash
npx darkrelay youtube match <show>
```

It pairs each episode with the channel upload of the same title, ignoring case and punctuation. Each line is `match <title> -> <video>` or `none <title>`. An episode shows `none` when no upload has its title, or when several do (it won't guess). Then link the matches:

```bash
npx darkrelay youtube match <show> --apply
```

Link each remaining `none` episode by hand. `npx darkrelay episodes <show>` lists every episode with its GUID in brackets:

```bash
npx darkrelay youtube link <show> <guid> https://youtu.be/<id>
```

Episodes already linked are skipped, so `match` is safe to run again. `npx darkrelay youtube status <show>` shows each episode's video.

## 6. Backfill the analytics

Linked videos pick up new views from the next nightly pull. To load their history, pull from around when the first video went up:

```bash
npx darkrelay analytics run --source youtube --from 2024-01-01
```

YouTube keeps the full history, so you can go back as far as the channel does. Each run covers at most 400 days; split longer histories with `--from` and `--to`. Retention curves are pulled for videos published in the last year. See [Running analytics by hand](running-analytics.md) for more.

## What happens next

See [YouTube in the README](https://github.com/chaotictoejam/darkrelay#youtube) for how uploads work and the private-upload limit on new Google Cloud projects.
