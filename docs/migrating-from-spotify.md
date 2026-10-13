# Moving a podcast from Spotify for Creators to DarkRelay

This guide moves one show hosted on Spotify for Creators (formerly Anchor) to your DarkRelay
deployment without losing subscribers. Listeners don't need to do anything: their apps follow the
redirect. Repeat it for each show. If you have several, move one first as a pilot.

Throughout, replace:

| Placeholder      | Meaning                                               | Example                                  |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- |
| `<show>`         | The slug you choose for the show in DarkRelay         | `my-show`                                |
| `<spotify-feed>` | The show's current RSS feed from Spotify for Creators | `https://anchor.fm/s/abc123/podcast/rss` |
| `<domain>`       | Your DarkRelay media domain                           | `media.example.com`                      |

Your new feed will be `https://<domain>/<show>/feed.xml`.

## What stays the same

Podcast apps identify a show by its `podcast:guid` and each episode by its `<guid>`. DarkRelay
keeps both exactly. If the Spotify feed never declared a `podcast:guid`, DarkRelay derives it from
the Spotify feed URL, as the Podcasting 2.0 spec requires, so apps see the same show. Changing
either would make apps show duplicates.

## Before you start

- **Deploy DarkRelay** (`npm run deploy`) and confirm downloads are being counted:
  `npx darkrelay analytics check` once a few requests have been made.
- **Find the Spotify feed URL.** In Spotify for Creators, open the show's settings and copy its RSS
  feed. It looks like `https://anchor.fm/s/<id>/podcast/rss`.
- **Stop publishing on Spotify** from step 1 until the redirect is confirmed in step 5. The import
  is a snapshot: an episode published on Spotify after it won't be in DarkRelay. If one slips
  through, publish it again on DarkRelay before cutting over. Don't re-run `import --force` after
  step 2, because it would point the show back at Spotify's media.
- **If you use Spotify Subscriptions,** turn them off in the Monetize tab.
- **Video episodes:** video uploaded directly to Spotify for Creators may not carry over once the
  show is served from an outside feed, so Spotify may show those episodes as audio only. Check
  Spotify's current policy before moving a video show.

## 1. Import (private, reversible)

```bash
npx darkrelay import <spotify-feed> --show <show> --dry-run   # look first
npx darkrelay import <spotify-feed> --show <show>
```

This copies the show and episode details into a **draft** show. Media stays on Spotify and nothing
public changes. Read the warnings it prints.

Titles are safe to tidy now (only GUIDs must stay the same). Spotify feeds sometimes carry a
literal `&amp;` in titles; fix it in the show file and run `npx darkrelay show put <file>`.

## 2. Copy the media

```bash
npx darkrelay migrate-media <show> --dry-run
npx darkrelay migrate-media <show>
```

This copies every episode's audio, artwork, transcripts and chapters into your bucket, checking
each audio file's size against the feed. Re-run it until nothing fails; finished episodes are
skipped.

## 3. Check the preview

```bash
npx darkrelay status <show>
npx darkrelay episodes <show>
```

`status` shows where the private preview feed is. Validate it with `npx darkrelay validate <file>`,
and if you like, open it in a podcast app that accepts a custom feed URL.

## 4. Go live on DarkRelay

```bash
npx darkrelay cutover <show>        # preflight only: changes nothing
npx darkrelay cutover <show> --go   # publish the feed, verify it, notify Podcast Index
```

The preflight refuses to continue if any media is still on Spotify, the feed is locked, the new
feed fails validation, the show's GUID differs, or any episode in the Spotify feed is missing from
the new one.

## 5. Redirect the Spotify feed

This has to be done on the website; the mobile app can't set a redirect.

1. Sign in at [creators.spotify.com](https://creators.spotify.com).
2. Open **Settings**, find **Redirect your podcast**, paste `https://<domain>/<show>/feed.xml`,
   and select **Redirect**.
3. Select **Check redirect status**. It can take from minutes to hours.

Confirm from DarkRelay's side:

```bash
npx darkrelay cutover <show> --check-redirect
```

It passes when the Spotify feed answers with a 301 to your feed, or carries
`<itunes:new-feed-url>` pointing at it.

## 6. After the move

- **Publish only on DarkRelay** from now on: `npx darkrelay publish`.
- **Keep the Spotify account and redirect for at least 45 days.** Apple Podcasts, Overcast and the
  rest move over the next time they check the feed, and Spotify's own listing follows the redirect.
  If Spotify's listing doesn't update, see Spotify's article on updating a show's RSS link.
- **Close the Spotify for Creators account only** once the redirect is confirmed and the DarkRelay
  dashboard shows downloads arriving from the usual apps.

## If something goes wrong

- **Before step 5,** nothing has changed for listeners. To back out of step 4, run
  `npx darkrelay show draft <show>`; the public DarkRelay feed stops updating and Spotify keeps
  serving your audience.
- **After step 5,** remove the redirect in Spotify for Creators to send apps back to Spotify's
  feed. Apps that already moved stay on the DarkRelay feed, so keep it live.

## References

- [Switching away from Spotify for Creators with a 301 redirect](https://support.spotify.com/us/creators/article/switching-away-from-spotify-for-creators-with-a-301-redirect/) (Spotify)
- [Updating an RSS feed link or hosting provider](https://support.spotify.com/us/creators/article/updating-an-rss-feed-link-or-hosting-provider/) (Spotify)
- [How do I redirect my podcast from Spotify for Creators?](https://help.rss.com/en/support/solutions/articles/44002264641-how-do-i-redirect-my-podcast-from-spotify-for-creators-formerly-anchor-) (RSS.com)
- [How to switch podcast hosting platforms without losing listeners](https://transistor.fm/switching-podcast-hosting/) (Transistor)
