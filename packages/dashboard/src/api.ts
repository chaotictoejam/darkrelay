import { currentToken, signIn, type RuntimeConfig } from './auth';

export interface Day {
  date: string;
  downloads: number;
  serverDownloads: number;
}

export interface Breakdown {
  downloads: number;
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

export async function get<T>(config: RuntimeConfig, path: string): Promise<T> {
  const token = currentToken();
  if (!token) return signIn(config);
  const res = await fetch(`${config.apiUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return signIn(config);
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}
