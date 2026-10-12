import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleEndpoints } from '@darkrelay/core';

interface Session {
  metadata: { snippet: Record<string, unknown>; status: Record<string, unknown> };
  total: number;
  received: Buffer[];
  bytes: number;
}

/** Just enough of YouTube's upload and Analytics APIs to test against real HTTP. */
export class FakeYouTube {
  server!: Server;
  endpoints!: GoogleEndpoints;
  sessions = new Map<string, Session>();
  videos = new Map<string, { metadata: Session['metadata']; bytes: Buffer }>();
  calls: { method: string; path: string }[] = [];
  thumbnails: string[] = [];
  captions: { videoId: string; body: string }[] = [];
  playlist: { playlistId: string; videoId: string }[] = [];
  statusUpdates: { id: string; status: Record<string, unknown> }[] = [];
  /** Chunks to fail with a 503 after storing nothing (simulates a dropped connection). */
  failNextChunks = 0;
  /** What the "audit" forces new videos to. */
  forcePrivate = false;
  reports: (params: URLSearchParams) => { columnHeaders: { name: string }[]; rows: unknown[][] } =
    () => ({
      columnHeaders: [],
      rows: [],
    });
  private next = 1;

  async start() {
    this.server = createServer((req, res) =>
      this.handle(req).then(
        ({ status, headers, body }) => {
          res.writeHead(status, headers);
          res.end(
            body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          );
        },
        (e) => {
          res.writeHead(500);
          res.end(String(e));
        },
      ),
    );
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.endpoints = { oauth: `${base}/oauth`, api: base, analytics: `${base}/analytics` };
    return this;
  }

  stop() {
    this.server.close();
  }

  private async read(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; headers?: Record<string, string>; body?: unknown }> {
    const url = new URL(req.url!, 'http://x');
    this.calls.push({ method: req.method!, path: url.pathname });
    const body = await this.read(req);

    if (url.pathname === '/oauth/token') return { status: 200, body: { access_token: 'token' } };
    if (req.headers.authorization !== 'Bearer token') return { status: 401, body: 'no auth' };

    if (url.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
      const id = `s${this.next++}`;
      this.sessions.set(id, {
        metadata: JSON.parse(body.toString()),
        total: Number(req.headers['x-upload-content-length']),
        received: [],
        bytes: 0,
      });
      const { port } = this.server.address() as AddressInfo;
      return { status: 200, headers: { location: `http://127.0.0.1:${port}/session/${id}` } };
    }
    if (url.pathname.startsWith('/session/') && req.method === 'PUT') {
      const s = this.sessions.get(url.pathname.split('/')[2]!)!;
      const range = String(req.headers['content-range']);
      if (!range.startsWith('bytes */')) {
        if (this.failNextChunks > 0) {
          this.failNextChunks--;
          return { status: 503, body: 'try again' };
        }
        const start = Number(/bytes (\d+)-/.exec(range)![1]);
        if (start !== s.bytes) return { status: 400, body: `expected ${s.bytes}, got ${start}` };
        s.received.push(body);
        s.bytes += body.length;
      }
      if (s.bytes < s.total) {
        return { status: 308, headers: s.bytes ? { range: `bytes=0-${s.bytes - 1}` } : {} };
      }
      const id = `vid${this.videos.size + 1}`;
      this.videos.set(id, { metadata: s.metadata, bytes: Buffer.concat(s.received) });
      const status = this.forcePrivate
        ? { ...s.metadata.status, privacyStatus: 'private' }
        : s.metadata.status;
      return { status: 200, body: { id, status } };
    }
    if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
      this.thumbnails.push(url.searchParams.get('videoId')!);
      return { status: 200, body: {} };
    }
    if (url.pathname === '/upload/youtube/v3/captions') {
      const text = body.toString();
      this.captions.push({ videoId: /"videoId":"([^"]+)"/.exec(text)![1]!, body: text });
      return { status: 200, body: {} };
    }
    if (url.pathname === '/youtube/v3/playlistItems' && req.method === 'POST') {
      const j = JSON.parse(body.toString());
      this.playlist.push({
        playlistId: j.snippet.playlistId,
        videoId: j.snippet.resourceId.videoId,
      });
      return { status: 200, body: {} };
    }
    if (url.pathname === '/youtube/v3/videos' && req.method === 'PUT') {
      this.statusUpdates.push(JSON.parse(body.toString()));
      return { status: 200, body: {} };
    }
    if (url.pathname === '/analytics/v2/reports')
      return { status: 200, body: this.reports(url.searchParams) };
    return { status: 404, body: `no route ${req.method} ${url.pathname}` };
  }
}
