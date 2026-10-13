# Privacy policy

_Effective 12 October 2026_

DarkRelay is self-hosted software. You deploy it in your own AWS account, create your own Google Cloud app, and connect your own YouTube channel to publish your own podcast. The DarkRelay project does not run a shared service and never receives your data.

## What DarkRelay accesses on YouTube

When you connect a YouTube channel, DarkRelay asks Google for two permissions:

- **Manage your YouTube account** (`youtube.force-ssl`): to upload episode videos, set their title, description, captions, thumbnail and publish time, and add them to a playlist. It also reads the channel's uploads so episodes can be matched to videos already on YouTube.
- **View YouTube Analytics reports for your channel** (`yt-analytics.readonly`): to read views, watch time and audience retention for the channel's videos.

DarkRelay does not read comments, messages, subscribers' personal information, or anything outside the connected channel.

## How the data is used and stored

- The Google sign-in token is stored encrypted in AWS Systems Manager Parameter Store in your AWS account.
- Video IDs, upload status and the analytics figures above are stored in your Amazon S3 bucket and shown in your DarkRelay dashboard.
- The data is used only to publish your episodes and report on them to you. It is not sold, shared with third parties, or used for advertising.

DarkRelay's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## YouTube and Google

DarkRelay uses YouTube API Services. By connecting a channel you also agree to the [YouTube Terms of Service](https://www.youtube.com/t/terms), and Google's handling of your data is covered by the [Google Privacy Policy](https://policies.google.com/privacy).

## Revoking access and deleting data

You can revoke DarkRelay's access at any time from your [Google Account permissions page](https://myaccount.google.com/connections). To delete what DarkRelay stored, remove the token from Parameter Store and the analytics from your S3 bucket.

## Podcast listeners

DarkRelay counts episode downloads from your CloudFront access logs. Those logs include IP addresses and user agents; they stay in your AWS account and are used only to produce download counts.

## Changes and contact

Changes to this policy will be posted on this page with a new effective date. Each DarkRelay app is run by the person who deployed it: contact them at the user support email shown on the app's Google sign-in screen.
