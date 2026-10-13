# Connecting a show to YouTube

This guide connects a DarkRelay show to a YouTube channel so episode videos upload automatically and views, watch time and retention flow back into the dashboard. You do steps 1 and 2 once per deployment, and steps 3 and 4 once per channel.

## 1. Create a Google Cloud project

In [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the _YouTube Data API v3_ and _YouTube Analytics API_, configure the OAuth consent screen (External), then **publish it ("In production")**. In "Testing", Google expires the tokens every 7 days.

## 2. Create an OAuth client

Create an OAuth client of type **Desktop app**, download its JSON, and store it:

```bash
npx darkrelay youtube client --file client_secret.json
```

## 3. Connect each channel

Google asks which channel if the account has several:

```bash
npx darkrelay youtube connect her-career-unplugged
npx darkrelay youtube connect chaotic-commits
```

Secrets are SSM Parameter Store SecureStrings under `/darkrelay/`; nothing is stored in the repo.

## 4. Add YouTube to the show file

Add a `youtube` block and `npx darkrelay show put` it:

```json
"youtube": { "connection": "her-career-unplugged", "categoryId": "27", "playlistId": "PL..." }
```

Options: `upload` (default `true`), `privacy` (`public`, `unlisted`, `private`), `categoryId` (22 People & Blogs, 27 Education, 28 Science & Technology), `playlistId`, `tags`, `descriptionFooter`.

Once connected, see [YouTube in the README](../README.md#youtube) for how uploads work, the private-upload limit on new Google Cloud projects, and linking episodes already on YouTube.
