import { currentToken, signIn, type RuntimeConfig } from './auth';

export interface Day {
  date: string;
  downloads: number;
  serverDownloads: number;
}

export interface Breakdown {
  downloads: number;
  watchSeconds?: number;
  serverDownloads: number;
  apps: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
}

export interface EpisodeSummary {
  show: string;
  episodeId: string;
  title: string;
  pubDate: string;
  downloads7: number;
  downloads30: number;
  downloads90: number;
  downloadsTotal: number;
  serverTotal: number;
}

export interface SeriesResponse {
  show: string;
  from: string;
  to: string;
  daily: Day[];
  totals: Breakdown;
  sources: string[];
  bySource: { source: string; plays: number; watchSeconds: number }[];
}

export interface ShowResponse extends SeriesResponse {
  episodes: EpisodeSummary[];
}

export interface EpisodeResponse extends SeriesResponse {
  episode: EpisodeSummary;
}

export interface ShowsResponse {
  shows: { show: string; title: string }[];
  lastRun: { date: string; updatedAt: string } | null;
}

/** What the signed-in user may do. `view` is null for admins (every show). */
export interface MeResponse {
  admin: boolean;
  view: string[] | null;
  upload: { show: string; title: string }[];
}

export interface CreateUploadResponse {
  bundleId: string;
  files: { name: string; uploadId: string; partSize: number; partCount: number }[];
}

export interface UploadStatus {
  bundleId: string;
  status: 'uploading' | 'queued' | 'processing' | 'published' | 'rejected';
  guid?: string;
  errors?: string[];
  scheduledFor?: string;
  feed?: string;
  feedErrors?: unknown;
}

export async function get<T>(config: RuntimeConfig, path: string): Promise<T> {
  return request<T>(config, 'GET', path);
}

export async function post<T>(config: RuntimeConfig, path: string, body: unknown): Promise<T> {
  return request<T>(config, 'POST', path, body);
}

async function request<T>(
  config: RuntimeConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = currentToken();
  if (!token) return signIn(config);
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) return signIn(config);
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}
