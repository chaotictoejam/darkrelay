import { spawn } from 'node:child_process';

export interface Probe {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  hasAudio: boolean;
}

interface FfprobeJson {
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }[];
  format?: { duration?: string };
}

function rate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [n, d] = value.split('/').map(Number);
  const r = d ? n! / d : n!;
  return Number.isFinite(r) && r > 0 ? r : undefined;
}

export function parseProbe(json: FfprobeJson): Probe {
  const video = json.streams?.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('No video stream in the uploaded file');
  return {
    width: video.width,
    height: video.height,
    fps: rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) ?? 30,
    durationSeconds: Number(json.format?.duration ?? 0),
    hasAudio: json.streams?.some((s) => s.codec_type === 'audio') ?? false,
  };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Ladder heights no taller than the source; the source height if all are. */
export function selectLadder(ladder: number[], sourceHeight: number): number[] {
  const fit = [...new Set(ladder)].filter((h) => h <= sourceHeight).sort((a, b) => b - a);
  return fit.length ? fit : [even(sourceHeight)];
}

/** Target H.264 video bitrate in kbps, scaled by pixel count from 1080p at 5000k. */
export function videoKbps(height: number, fps: number): number {
  const base = 5000 * (height / 1080) ** 2 * (fps > 40 ? 1.5 : 1);
  return Math.max(300, Math.round(base / 50) * 50);
}

export interface PlannedRendition {
  height: number;
  width: number;
  videoKbps: number;
  bandwidth: number;
}

export const AUDIO_KBPS = 128;

export function planRenditions(probe: Probe, ladder: number[]): PlannedRendition[] {
  return selectLadder(ladder, probe.height).map((height) => {
    const kbps = videoKbps(height, probe.fps);
    return {
      height,
      width: even((probe.width * height) / probe.height),
      videoKbps: kbps,
      bandwidth: Math.round((kbps * 1.1 + (probe.hasAudio ? AUDIO_KBPS : 0)) * 1000),
    };
  });
}

export const SEGMENT_SECONDS = 6;

/**
 * One ffmpeg pass that writes every rendition: H.264 + AAC in 6-second
 * MPEG-TS segments, keyframes every 2 s so segments cut cleanly, and a
 * master playlist. Output: <out>/master.m3u8 and <out>/v<n>/index.m3u8.
 */
export function hlsArgs(
  input: string,
  outDir: string,
  probe: Probe,
  renditions: PlannedRendition[],
): string[] {
  const n = renditions.length;
  const gop = Math.max(1, Math.round(probe.fps * 2));
  const split = `[0:v]split=${n}${renditions.map((_, i) => `[s${i}]`).join('')}`;
  const scales = renditions.map(
    (r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic[v${i}]`,
  );
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-y', '-i', input];
  args.push('-filter_complex', [split, ...scales].join(';'));
  renditions.forEach((r, i) => {
    args.push(
      '-map',
      `[v${i}]`,
      `-c:v:${i}`,
      'libx264',
      `-b:v:${i}`,
      `${r.videoKbps}k`,
      `-maxrate:v:${i}`,
      `${Math.round(r.videoKbps * 1.1)}k`,
      `-bufsize:v:${i}`,
      `${r.videoKbps * 2}k`,
    );
  });
  if (probe.hasAudio) {
    for (let i = 0; i < n; i++) args.push('-map', '0:a:0');
    args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', '-ar', '48000');
  }
  args.push(
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-sc_threshold',
    '0',
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_type',
    'mpegts',
    '-hls_segment_filename',
    `${outDir}/v%v/seg_%05d.ts`,
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    renditions.map((_, i) => (probe.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
    `${outDir}/v%v/index.m3u8`,
  );
  return args;
}

/** Audio for the feed: 128 kbps stereo MP3. Darkroom already normalised loudness. */
export function audioArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    input,
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-ar',
    '44100',
    output,
  ];
}

export function probeArgs(input: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input];
}

export function run(cmd: string, args: string[], capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

export const HLS_CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
};
