/**
 * The few Google endpoints DarkRelay uses, over fetch. Base URLs are
 * injectable so tests can point them at a local fake.
 */
export interface GoogleEndpoints {
  oauth: string;
  api: string;
  analytics: string;
}

export const GOOGLE: GoogleEndpoints = {
  oauth: 'https://oauth2.googleapis.com',
  api: 'https://www.googleapis.com',
  analytics: 'https://youtubeanalytics.googleapis.com',
};

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${body.slice(0, 300)}`);
  }
}

async function check(res: Response, what: string) {
  if (!res.ok) throw new GoogleApiError(res.status, await res.text(), what);
  return res;
}

export async function refreshAccessToken(
  creds: ClientCredentials,
  refreshToken: string,
  endpoints = GOOGLE,
): Promise<string> {
  const res = await check(
    await fetch(`${endpoints.oauth}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
      }),
    }),
    'Refreshing the YouTube token (if this says invalid_grant, run darkrelay youtube connect again)',
  );
  return ((await res.json()) as { access_token: string }).access_token;
}

export type ChunkResult = { done: false; next: number } | { done: true; video: YouTubeVideo };

export interface YouTubeVideo {
  id: string;
  status?: { privacyStatus?: string; uploadStatus?: string; publishAt?: string };
}

/** Parses "bytes=0-1234" from a 308 Resume Incomplete response. */
export function nextOffset(range: string | null): number {
  const m = range && /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

export class YouTube {
  constructor(
    private readonly token: string,
    private readonly endpoints = GOOGLE,
  ) {}

  private auth(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async json<T>(url: string, init: RequestInit, what: string): Promise<T> {
    const res = await check(
      await fetch(url, { ...init, headers: { ...this.auth(), ...(init.headers as object) } }),
      what,
    );
    return (await res.json()) as T;
  }

  /** Starts a resumable upload and returns the session URI. */
  async startUpload(resource: unknown, size: number, contentType: string): Promise<string> {
    const res = await check(
      await fetch(
        `${this.endpoints.api}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
        {
          method: 'POST',
          headers: this.auth({
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-length': String(size),
            'x-upload-content-type': contentType,
          }),
          body: JSON.stringify(resource),
        },
      ),
      'Starting the YouTube upload',
    );
    const location = res.headers.get('location');
    if (!location) throw new Error('YouTube did not return an upload session');
    return location;
  }

  /** Sends bytes [start, start+body.length) of `total`. */
  async uploadChunk(
    sessionUri: string,
    body: Uint8Array,
    start: number,
    total: number,
  ): Promise<ChunkResult> {
    const end = start + body.length - 1;
    const res = await fetch(sessionUri, {
      method: 'PUT',
      headers: this.auth({
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${end}/${total}`,
      }),
      body,
    });
    return this.chunkResult(res, 'Uploading to YouTube');
  }

  /** Asks the session how much it has, after an interruption. */
  async uploadStatus(sessionUri: string, total: number): Promise<ChunkResult> {
    const res = await fetch(sessionUri, {
      method: 'PUT',
      headers: this.auth({ 'content-length': '0', 'content-range': `bytes */${total}` }),
    });
    return this.chunkResult(res, 'Checking the YouTube upload');
  }

  private async chunkResult(res: Response, what: string): Promise<ChunkResult> {
    if (res.status === 308) return { done: false, next: nextOffset(res.headers.get('range')) };
    await check(res, what);
    return { done: true, video: (await res.json()) as YouTubeVideo };
  }

  async setThumbnail(videoId: string, body: Uint8Array, contentType: string) {
    await this.json(
      `${this.endpoints.api}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
      { method: 'POST', headers: { 'content-type': contentType }, body },
      'Setting the thumbnail',
    );
  }

  /** Uploads a caption track (VTT or SRT) as a multipart request. */
  async insertCaption(videoId: string, language: string, body: Uint8Array) {
    const boundary = `darkrelay${Date.now()}`;
    const meta = JSON.stringify({ snippet: { videoId, language, name: '', isDraft: false } });
    const head = new TextEncoder().encode(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const multipart = new Uint8Array(head.length + body.length + tail.length);
    multipart.set(head, 0);
    multipart.set(body, head.length);
    multipart.set(tail, head.length + body.length);
    await this.json(
      `${this.endpoints.api}/upload/youtube/v3/captions?uploadType=multipart&part=snippet`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: multipart,
      },
      'Adding captions',
    );
  }

  async addToPlaylist(playlistId: string, videoId: string) {
    await this.json(
      `${this.endpoints.api}/youtube/v3/playlistItems?part=snippet`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
        }),
      },
      'Adding to the playlist',
    );
  }

  async updateStatus(videoId: string, status: Record<string, unknown>) {
    await this.json(
      `${this.endpoints.api}/youtube/v3/videos?part=status`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: videoId, status }),
      },
      'Updating the video status',
    );
  }

  async myChannel(): Promise<{ id: string; title: string; uploadsPlaylist: string }> {
    const r = await this.json<{
      items?: {
        id: string;
        snippet: { title: string };
        contentDetails: { relatedPlaylists: { uploads: string } };
      }[];
    }>(
      `${this.endpoints.api}/youtube/v3/channels?part=snippet,contentDetails&mine=true`,
      {},
      'Reading the channel',
    );
    const c = r.items?.[0];
    if (!c) throw new Error('This Google account has no YouTube channel');
    return {
      id: c.id,
      title: c.snippet.title,
      uploadsPlaylist: c.contentDetails.relatedPlaylists.uploads,
    };
  }

  /** Every video in the channel's uploads playlist, newest first. */
  async listUploads(
    uploadsPlaylist: string,
  ): Promise<{ videoId: string; title: string; description: string; publishedAt: string }[]> {
    const out: { videoId: string; title: string; description: string; publishedAt: string }[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.endpoints.api}/youtube/v3/playlistItems`);
      url.search = new URLSearchParams({
        part: 'snippet,contentDetails',
        playlistId: uploadsPlaylist,
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const r = await this.json<{
        nextPageToken?: string;
        items?: {
          snippet: { title: string; description?: string };
          contentDetails: { videoId: string; videoPublishedAt?: string };
        }[];
      }>(url.toString(), {}, 'Listing uploads');
      for (const i of r.items ?? []) {
        out.push({
          videoId: i.contentDetails.videoId,
          title: i.snippet.title,
          description: i.snippet.description ?? '',
          publishedAt: i.contentDetails.videoPublishedAt ?? '',
        });
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** YouTube Analytics report rows as objects keyed by column name. */
  async report(params: Record<string, string>): Promise<Record<string, string | number>[]> {
    const url = new URL(`${this.endpoints.analytics}/v2/reports`);
    url.search = new URLSearchParams({ ids: 'channel==MINE', ...params }).toString();
    const r = await this.json<{ columnHeaders?: { name: string }[]; rows?: (string | number)[][] }>(
      url.toString(),
      {},
      'Reading YouTube Analytics',
    );
    const cols = (r.columnHeaders ?? []).map((c) => c.name);
    return (r.rows ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]!])));
  }
}
