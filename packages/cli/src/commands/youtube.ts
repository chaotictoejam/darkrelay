import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  EpisodeManifest,
  UploadState,
  YouTube,
  episodeId,
  layout,
  refreshAccessToken,
  type ClientCredentials,
  type ShowConfig,
} from '@darkrelay/core';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { loadEpisodes, loadShow } from './show';

const region = 'us-east-1';
const SCOPES = [
  // Upload, captions, thumbnails, playlists and scheduling.
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const prefix = (g: GlobalOptions) => `/${g.stackPrefix.toLowerCase()}`;
const clientPath = (g: GlobalOptions) => `${prefix(g)}/google-client`;
const connectionPath = (g: GlobalOptions, name: string) => `${prefix(g)}/youtube/${name}`;

async function putSecret(name: string, value: unknown) {
  await new SSMClient({ region }).send(
    new PutParameterCommand({
      Name: name,
      Value: JSON.stringify(value),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
}

async function getSecret<T>(name: string): Promise<T | undefined> {
  try {
    const r = await new SSMClient({ region }).send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return JSON.parse(r.Parameter!.Value!) as T;
  } catch (e) {
    if (e instanceof ParameterNotFound) return undefined;
    throw e;
  }
}

/**
 * Stores the Google OAuth client (a "Desktop app" client from Google Cloud
 * Console) in SSM. Pass the client_secret JSON Google lets you download, or
 * the id and secret.
 */
export async function setClient(
  flags: { file?: string; clientId?: string; clientSecret?: string },
  g: GlobalOptions,
) {
  let creds: ClientCredentials;
  if (flags.file) {
    const j = JSON.parse(await readFile(flags.file, 'utf8')) as Record<
      string,
      { client_id: string; client_secret: string }
    >;
    const c = j['installed'] ?? j['web'];
    if (!c) throw new Error('Not a Google OAuth client file (expected "installed" or "web")');
    creds = { clientId: c.client_id, clientSecret: c.client_secret };
  } else if (flags.clientId && flags.clientSecret) {
    creds = { clientId: flags.clientId, clientSecret: flags.clientSecret };
  } else {
    throw new Error('Pass --file client_secret.json, or --client-id and --client-secret');
  }
  await putSecret(clientPath(g), creds);
  console.log(
    `Saved the Google OAuth client to SSM ${clientPath(g)}. Next: darkrelay youtube connect <name>`,
  );
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Signs in to a YouTube channel in the browser and stores its refresh token
 * in SSM. Google asks which channel when the account has several (brand
 * accounts), so connect once per channel with a name per channel.
 */
export async function connect(name: string, g: GlobalOptions) {
  if (!/^[a-z0-9-]{1,40}$/.test(name))
    throw new Error('Connection names are lowercase letters, digits and dashes');
  const creds = await getSecret<ClientCredentials>(clientPath(g));
  if (!creds)
    throw new Error(
      'No Google OAuth client yet. Run: darkrelay youtube client --file client_secret.json',
    );

  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('hex');
  let redirectUri = '';
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (url.pathname !== '/') return void res.writeHead(404).end();
      const error = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const ok = !error && got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
      res.end(
        ok
          ? 'DarkRelay is connected. You can close this tab.'
          : `Sign-in failed: ${error ?? 'state mismatch'}`,
      );
      server.close();
      if (ok) resolve(got);
      else reject(new Error(`Sign-in failed: ${error ?? 'state mismatch'}`));
    });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        // Offline + consent so Google returns a refresh token every time.
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      console.log(`Open this link, sign in, and pick the channel for "${name}":\n\n${url}\n`);
    });
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code_verifier: verifier,
    }),
  });
  const body = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    error_description?: string;
  };
  if (!res.ok || !body.refresh_token)
    throw new Error(`Token exchange failed: ${body.error_description ?? res.status}`);

  const channel = await new YouTube(body.access_token!).myChannel();
  await putSecret(connectionPath(g, name), {
    refreshToken: body.refresh_token,
    channelId: channel.id,
    channelTitle: channel.title,
  });
  console.log(`Connected "${name}" to ${channel.title} (${channel.id}).`);
  console.log(
    'Add to the show file: "youtube": { "connection": "' + name + '" }, then: darkrelay show put',
  );
  console.log(
    'If your Google OAuth app is still in "Testing", this token expires in 7 days. Set it to "In production" in Google Cloud Console.',
  );
}

async function clientFor(show: ShowConfig, g: GlobalOptions) {
  if (!show.youtube) throw new Error(`${show.slug} has no "youtube" settings in its show file`);
  const creds = await getSecret<ClientCredentials>(clientPath(g));
  const secret = await getSecret<{ refreshToken: string }>(
    connectionPath(g, show.youtube.connection),
  );
  if (!creds || !secret)
    throw new Error(
      `Connection "${show.youtube.connection}" not set up. Run: darkrelay youtube connect ${show.youtube.connection}`,
    );
  return new YouTube(await refreshAccessToken(creds, secret.refreshToken));
}

/** Lowercase letters and digits only, entities decoded, so titles compare across platforms. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface Match {
  guid: string;
  title: string;
  videoId: string;
  /** Whether the video's title or its description named the episode. */
  by: 'title' | 'description';
}

/**
 * Pairs unlinked episodes with channel uploads. First by identical title; then, for
 * videos with their own YouTube title, by the episode title appearing in the video's
 * description. Anything ambiguous (two candidate videos, or one video naming two
 * episodes) is left out for linking by hand.
 */
export function matchUploads(
  episodes: Pick<EpisodeManifest, 'guid' | 'title' | 'youtube'>[],
  uploads: { videoId: string; title: string; description?: string }[],
): { matches: Match[]; unmatched: string[] } {
  const byTitle = new Map<string, string[]>();
  for (const u of uploads) {
    const k = normalizeTitle(u.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), u.videoId]);
  }
  const taken = new Set(episodes.map((e) => e.youtube?.videoId).filter(Boolean));
  const matches: Match[] = [];
  let rest: Pick<EpisodeManifest, 'guid' | 'title'>[] = [];
  for (const e of episodes) {
    if (e.youtube) continue;
    const ids = (byTitle.get(normalizeTitle(e.title)) ?? []).filter((id) => !taken.has(id));
    if (ids.length === 1) {
      matches.push({ guid: e.guid, title: e.title, videoId: ids[0]!, by: 'title' });
      taken.add(ids[0]!);
    } else {
      rest.push(e);
    }
  }

  // Padded with spaces so "episode 1" doesn't match inside "episode 12".
  const pad = (t: string) => ` ${normalizeTitle(t)} `;
  rest = rest.filter((e) => pad(e.title).trim());
  const candidates = new Map<string, string[]>();
  for (const u of uploads) {
    if (taken.has(u.videoId) || !u.description) continue;
    const description = pad(u.description);
    const named = rest.filter((e) => description.includes(pad(e.title)));
    // "Git Basics Part 2" also contains "Git Basics": keep only the longest titles named.
    for (const e of named) {
      if (named.some((o) => o !== e && pad(o.title).includes(pad(e.title)))) continue;
      candidates.set(e.guid, [...(candidates.get(e.guid) ?? []), u.videoId]);
    }
  }
  const claims = new Map<string, number>();
  for (const ids of candidates.values()) {
    if (ids.length === 1) claims.set(ids[0]!, (claims.get(ids[0]!) ?? 0) + 1);
  }
  const unmatched: string[] = [];
  for (const e of episodes) {
    if (e.youtube || matches.some((m) => m.guid === e.guid)) continue;
    const ids = candidates.get(e.guid) ?? [];
    if (ids.length === 1 && claims.get(ids[0]!) === 1) {
      matches.push({ guid: e.guid, title: e.title, videoId: ids[0]!, by: 'description' });
    } else {
      unmatched.push(e.title);
    }
  }
  return { matches, unmatched };
}

async function setLink(bucket: Bucket, slug: string, manifest: EpisodeManifest, videoId: string) {
  const updated = EpisodeManifest.parse({
    ...manifest,
    youtube: { videoId, linkedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
  await bucket.putText(
    layout.episodeManifest(slug, episodeId(manifest.guid)),
    JSON.stringify(updated, null, 2),
  );
}

export function parseVideoId(input: string): string {
  const m = /(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(input);
  if (m) return m[1]!;
  if (/^[\w-]{11}$/.test(input)) return input;
  throw new Error(`Not a YouTube video id or URL: ${input}`);
}

/** Links an episode to a video already on YouTube, for analytics. Nothing is uploaded. */
export async function link(slug: string, guid: string, video: string, g: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(g)).bucket);
  const raw = await bucket.getText(layout.episodeManifest(slug, episodeId(guid)));
  if (!raw) throw new Error(`No episode with guid "${guid}" in ${slug}`);
  const videoId = parseVideoId(video);
  await setLink(bucket, slug, EpisodeManifest.parse(JSON.parse(raw)), videoId);
  console.log(`Linked to https://youtu.be/${videoId}`);
}

/** Finds existing channel uploads for unlinked episodes by title or description. --apply links them. */
export async function match(slug: string, flags: { apply?: boolean }, g: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(g)).bucket);
  const show = await loadShow(bucket, slug);
  if (!show) throw new Error(`Show "${slug}" does not exist`);
  const yt = await clientFor(show, g);
  const channel = await yt.myChannel();
  const episodes = await loadEpisodes(bucket, slug);
  const { matches, unmatched } = matchUploads(
    episodes,
    await yt.listUploads(channel.uploadsPlaylist),
  );
  for (const m of matches) {
    const via = m.by === 'description' ? '  (named in description)' : '';
    console.log(`  match   ${m.title}  ->  https://youtu.be/${m.videoId}${via}`);
  }
  for (const t of unmatched) console.log(`  none    ${t}`);
  if (!flags.apply) {
    console.log(`\n${matches.length} matches. Run again with --apply to link them.`);
    return;
  }
  for (const m of matches) {
    await setLink(
      bucket,
      slug,
      episodes.find((e) => e.guid === m.guid)!,
      m.videoId,
    );
  }
  console.log(
    `\nLinked ${matches.length} episodes. Views appear after the next nightly pull, or: darkrelay analytics run --source youtube`,
  );
}

/** Uploads (or re-uploads with --force) one episode now. */
export async function uploadNow(
  slug: string,
  guid: string,
  flags: { force?: boolean },
  g: GlobalOptions,
) {
  const r = await new LambdaClient({ region }).send(
    new InvokeCommand({
      FunctionName: `${g.stackPrefix}-youtube-upload`,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(
        JSON.stringify({ show: slug, episodeId: episodeId(guid), force: flags.force }),
      ),
    }),
  );
  if (r.FunctionError) throw new Error(`Could not start the upload: ${r.FunctionError}`);
  console.log(`Upload started. Check it with: darkrelay youtube status ${slug}`);
}

/** Each episode's YouTube video or upload progress. */
export async function status(slug: string, g: GlobalOptions) {
  const bucket = new Bucket((await resolveDeployment(g)).bucket);
  const episodes = (await loadEpisodes(bucket, slug)).sort((a, b) =>
    b.pubDate.localeCompare(a.pubDate),
  );
  for (const e of episodes) {
    const raw = await bucket.getText(layout.youtubeUpload(slug, episodeId(e.guid)));
    const s = raw ? UploadState.parse(JSON.parse(raw)) : undefined;
    let line: string;
    if (e.youtube)
      line = `https://youtu.be/${e.youtube.videoId}${e.youtube.publishAt ? ` (scheduled ${e.youtube.publishAt})` : ''}`;
    else if (s?.state === 'uploading')
      line = `uploading ${s.total ? Math.round((s.offset / s.total) * 100) : 0}%`;
    else if (s?.state === 'failed') line = `FAILED: ${s.error}`;
    else line = e.video ? 'not uploaded' : 'no video';
    console.log(`${e.pubDate.slice(0, 10)}  ${e.title}\n            ${line}`);
    for (const w of s?.warnings ?? []) console.log(`            warning: ${w}`);
  }
}
