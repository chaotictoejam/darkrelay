# Connecting a show to YouTube

This guide connects a DarkRelay show to a YouTube channel so episode videos upload automatically and views, watch time and retention flow back into the dashboard. You do steps 1 and 2 once per deployment, and steps 3 and 4 once per channel.

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

Add a `youtube` block to the show file and `npx darkrelay show put` it:

```json
"youtube": { "connection": "<connection>", "categoryId": "27", "playlistId": "<playlist>" }
```

Options: `upload` (default `true`), `privacy` (`public`, `unlisted`, `private`), `categoryId` (22 People & Blogs, 27 Education, 28 Science & Technology), `playlistId`, `tags`, `descriptionFooter`.

Once connected, see [YouTube in the README](https://github.com/chaotictoejam/darkrelay#youtube) for how uploads work, the private-upload limit on new Google Cloud projects, and linking episodes already on YouTube.
