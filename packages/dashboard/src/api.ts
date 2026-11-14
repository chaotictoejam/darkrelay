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
  /** Potential crawler downloads, already included in `downloads`. */
  suspectDownloads?: number;
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
  suspectTotal?: number;
}

/** An outlet as the ingestion runs record it on the brand's row. */
export interface Outlet {
  id: string;
  kind: string;
  name: string;
  source: string;
}

export interface OutletTotals extends Outlet {
  plays: number;
  watchSeconds: number;
  apps: Record<string, number>;
}

export interface VideoSummary {
  videoId: string;
  outlet?: string;
  title: string;
  /** When it was uploaded — not when a scheduled video goes live. */
  publishedAt: string;
  format: string;
  /** `public`, `private` or `unlisted`, where the platform reports it. */
  privacyStatus?: string;
  /** The release time the platform is holding a scheduled video for. */
  scheduledAt?: string;
  durationSeconds?: number;
  downloads7?: number;
  downloads30?: number;
  downloads90?: number;
  downloadsTotal?: number;
  watchSecondsTotal?: number;
}

export interface SeriesResponse {
  show: string;
  brand?: string;
  from: string;
  to: string;
  daily: Day[];
  totals: Breakdown;
  sources: string[];
  bySource: {
    source: string;
    plays: number;
    watchSeconds: number;
    apps: Record<string, number>;
  }[];
  byOutlet: OutletTotals[];
}

export interface ShowResponse extends SeriesResponse {
  title?: string;
  iconKey?: string;
  iconUrl?: string;
  outlets?: Outlet[];
  episodes: EpisodeSummary[];
  videos?: VideoSummary[];
}

export interface EpisodeResponse extends SeriesResponse {
  episode: EpisodeSummary;
}

export interface VideoResponse extends SeriesResponse {
  video: VideoSummary;
}

export interface BrandSummary {
  show: string;
  brand?: string;
  title: string;
  iconKey?: string;
  iconUrl?: string;
  outlets?: Outlet[];
}

/** Where a brand's new icon landed, after the API stored it. */
export interface BrandIconResponse {
  brand: string;
  iconKey: string;
  iconUrl?: string;
}

export interface ShowsResponse {
  shows: BrandSummary[];
  brands?: BrandSummary[];
  lastRun: { date: string; updatedAt: string } | null;
}

export interface ChannelDay {
  date: string;
  views: number;
  watchSeconds: number;
  subscribersGained: number;
  subscribersLost: number;
  trafficSources: Record<string, number>;
  formats: Record<string, { views: number; watchSeconds: number }>;
}

/** A channel's own numbers: properties of the outlet, not of one video. */
export interface OutletResponse {
  show: string;
  brand: string;
  title: string;
  outlet: Outlet;
  from: string;
  to: string;
  channel: {
    daily: ChannelDay[];
    totals: Omit<ChannelDay, 'date'>;
    subscriberChange: number;
  };
  content: SeriesResponse;
  videos: VideoSummary[];
}

/** One piece of content on the schedule, as the calendar shows it. */
export interface ScheduleEntry {
  brand: string;
  brandTitle: string;
  id: string;
  title: string;
  kind: string;
  publishAt?: string;
  outlet?: string;
  state?: string;
  externalId?: string;
  error?: string;
  warnings?: string[];
  parentId?: string;
}

export interface PendingPlan {
  brand: string;
  planId: string;
  createdAt: string;
  items: number;
  from: string;
  to: string;
  firstAt?: string;
}

/** Everything coming up, across every brand the viewer can see. */
export interface ScheduleResponse {
  now: string;
  brands: {
    brand: string;
    title: string;
    iconKey?: string;
    iconUrl?: string;
    canSchedule: boolean;
  }[];
  upcoming: ScheduleEntry[];
  unscheduled: ScheduleEntry[];
  plans: PendingPlan[];
}

/** One slot's score, as the heatmap reads it. */
export interface SlotScore {
  day: number;
  hour: number;
  key: string;
  score: number;
  samples: number;
  prior: number;
  basis: 'history' | 'blend' | 'prior';
  views?: number;
  viewRatio?: number;
  subsPerMille?: number;
  evidence?: { id: string; title?: string; publishedAt: string }[];
}

export interface SlotScoresResponse {
  zone: string;
  samples: number;
  fellBackToAllFormats?: boolean;
  slots: SlotScore[];
}

export interface PlanAssignment {
  id: string;
  title: string;
  kind: string;
  publishAt: string;
  slot: string;
  slotLabel: string;
  score: number;
  basis: 'history' | 'blend' | 'prior';
  explore: boolean;
  reason: string;
}

export interface SchedulePlan {
  planId: string;
  brand: string;
  outlet: string;
  zone: string;
  createdAt: string;
  from: string;
  to: string;
  perWeek: number;
  minGapHours: number;
  exploreShare: number;
  samples: number;
  assignments: PlanAssignment[];
  unplaced: { id: string; title: string; reason: string }[];
  untouched: { id: string; title: string; publishAt: string }[];
  warnings: string[];
  approvedAt?: string;
  applied: { id: string; publishAt: string }[];
}

export interface PlansResponse {
  brand: string;
  plans: SchedulePlan[];
}

export interface ApprovalResponse {
  plan: SchedulePlan;
  applied: { id: string; publishAt: string }[];
  skipped: { id: string; reason: string }[];
}

/** What the signed-in user may do. `view` is null for admins (every show). */
export interface MeResponse {
  admin: boolean;
  view: string[] | null;
  /** Shows an episode can be uploaded to: a brand with no feed is not one. */
  upload: { show: string; title: string }[];
  /** Brands whose own settings — the icon — the user may change. */
  manage?: string[];
}

/** Brands the user may change. Older deployments send no `manage`. */
export function canManage(roles: MeResponse, brand: string): boolean {
  return (roles.manage ?? roles.upload.map((s) => s.show)).includes(brand);
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

export type EpisodeState = 'live' | 'scheduled' | 'hidden';

export interface CatalogResponse {
  show: string;
  episodes: {
    episodeId: string;
    title: string;
    pubDate: string;
    state: EpisodeState;
    season?: number;
    episode?: number;
  }[];
}

/** An existing episode, as the edit form needs it. */
export interface EpisodeDetails {
  episodeId: string;
  title: string;
  description: string;
  pubDate: string;
  state: EpisodeState;
  status: 'published' | 'hidden';
  durationSeconds?: number;
  season?: number;
  episode?: number;
  episodeType: 'full' | 'trailer' | 'bonus';
  explicit: boolean;
  files: {
    audio: string;
    video: boolean;
    transcripts: string[];
    chapters: boolean;
    cover: boolean;
    thumbnail: boolean;
  };
  youtube?: { videoId: string };
}

/** What the Shorts upload form opens with: where a clip can go, and what it came from. */
export interface ShortsFormContext {
  brand: string;
  title: string;
  timezone?: string;
  outlets: { id: string; label: string }[];
  episodes: { episodeId: string; title: string; pubDate: string }[];
  maxFiles: number;
}

export interface CreateBatchResponse {
  batchId: string;
  files: { name: string; uploadId: string; partSize: number; partCount: number }[];
}

/** The ingest's verdict on a batch, or where the upload has got to. */
export interface BatchStatus {
  batchId: string;
  brand?: string;
  status: 'uploading' | 'queued' | 'ingested' | 'rejected';
  outlet?: string;
  items?: { id: string; title: string; publishAt?: string }[];
  errors?: string[];
}

/** What came of moving one item's slot. */
export interface RescheduleResponse {
  id: string;
  title: string;
  publishAt: string;
  outlet?: string;
  state?: string;
  externalId?: string;
  /** The platform is being told the new time now, not at the next sweep. */
  syncing: boolean;
  warnings: string[];
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
