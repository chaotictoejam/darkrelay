import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  EpisodeInput,
  classifyBundle,
  contentTypeFor,
  layout,
  newBundleId,
  newEpisodeGuid,
  type EpisodeInputRaw,
} from '@darkrelay/core';
import { z } from 'zod';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { describeTime, parsePubDate } from '../dates';

export interface PublishFlags {
  show: string;
  title?: string;
  description?: string;
  notes?: string;
  pubDate?: string;
  season?: string;
  episode?: string;
  type?: string;
  explicit?: boolean;
  guid?: string;
  transcript?: string;
  chapters?: string;
  cover?: string;
  thumbnail?: string;
  video?: string;
  ytTitle?: string;
  /** File with the YouTube description (plain text). */
  ytDescription?: string;
  wait?: boolean;
}

export interface PlannedFile {
  name: string;
  path: string;
}

export interface PlannedBundle {
  input: EpisodeInput;
  files: PlannedFile[];
  /** Where episode.json is saved locally so a re-publish keeps the same guid. */
  sidecar: string;
}

export type DurationOf = (path: string) => Promise<number | undefined>;

/**
 * Turns a bundle directory, or a bare audio or video file plus flags, into the files to
 * upload. Flags override episode.json. Throws with every problem at once.
 */
export async function planBundle(
  target: string,
  flags: PublishFlags,
  durationOf: DurationOf,
): Promise<PlannedBundle> {
  const isDir = (await stat(target)).isDirectory();
  const files: PlannedFile[] = [];
  let sidecar: string;

  if (isDir) {
    sidecar = join(target, 'episode.json');
    for (const name of await readdir(target)) {
      if (name !== 'episode.json') files.push({ name, path: join(target, name) });
    }
  } else {
    sidecar = `${target}.episode.json`;
    const ext = extname(target).toLowerCase();
    // A video upload: the audio for the feed is extracted from it on Fargate.
    files.push({ name: ext === '.mp4' ? 'video.mp4' : `audio${ext}`, path: target });
  }
  const extra = (role: string, path: string | undefined) => {
    if (!path) return;
    const name = role === 'chapters' ? 'chapters.json' : `${role}${extname(path).toLowerCase()}`;
    const i = files.findIndex((f) => f.name === name);
    if (i >= 0) files.splice(i, 1);
    files.push({ name, path });
  };
  extra('transcript', flags.transcript);
  extra('chapters', flags.chapters);
  extra('cover', flags.cover);
  extra('thumbnail', flags.thumbnail);
  extra('video', flags.video);

  const { files: roles, errors, ignored } = classifyBundle(files.map((f) => f.name));
  if (errors.length) throw new Error(errors.join('\n'));
  const upload = files.filter((f) => !ignored.includes(f.name));

  const base: Partial<EpisodeInputRaw> = await readFile(sidecar, 'utf8')
    .then((t) => JSON.parse(t) as Partial<EpisodeInputRaw>)
    .catch(() => ({}));
  const mediaPath = upload.find((f) => f.name === (roles.audio ?? roles.video))!.path;
  const description = flags.notes
    ? await readFile(flags.notes, 'utf8')
    : (flags.description ?? base.description);
  const duration = base.durationSeconds ?? (await durationOf(mediaPath));
  const youtube =
    flags.ytTitle !== undefined || flags.ytDescription !== undefined
      ? {
          ...base.youtube,
          ...(flags.ytTitle !== undefined ? { title: flags.ytTitle } : {}),
          ...(flags.ytDescription !== undefined
            ? { description: await readFile(flags.ytDescription, 'utf8') }
            : {}),
        }
      : base.youtube;

  const raw: EpisodeInputRaw = {
    ...base,
    schemaVersion: 1,
    show: flags.show,
    guid: flags.guid ?? base.guid ?? newEpisodeGuid(),
    title: flags.title ?? base.title ?? '',
    description: description ?? '',
    pubDate: flags.pubDate ? parsePubDate(flags.pubDate).toISOString() : base.pubDate,
    durationSeconds: duration === undefined ? 0 : Math.round(duration),
    episodeType: (flags.type as EpisodeInputRaw['episodeType']) ?? base.episodeType,
    season: flags.season ? Number(flags.season) : base.season,
    episode: flags.episode ? Number(flags.episode) : base.episode,
    explicit: flags.explicit ?? base.explicit,
    youtube,
  };
  const parsed = EpisodeInput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Episode details incomplete:\n${z.prettifyError(parsed.error)}`);
  }
  return { input: parsed.data, files: upload, sidecar };
}

export async function publish(target: string, flags: PublishFlags, global: GlobalOptions) {
  const { parseFile } = await import('music-metadata');
  const plan = await planBundle(target, flags, async (p) => (await parseFile(p)).format.duration);
  const { bucket: bucketName } = await resolveDeployment(global);
  const bucket = new Bucket(bucketName);

  if (!(await bucket.exists(layout.showConfig(flags.show)))) {
    throw new Error(`Show "${flags.show}" does not exist. Create it with: darkrelay show put`);
  }

  const bundleId = newBundleId();
  const prefix = layout.inboxPrefix(flags.show, bundleId);
  for (const f of plan.files) {
    console.log(`Uploading ${basename(f.path)} -> ${f.name}`);
    await bucket.uploadFile(prefix + f.name, f.path, contentTypeFor(f.name));
  }
  // episode.json goes last: its arrival is what triggers publishing.
  await bucket.putText(prefix + 'episode.json', JSON.stringify(plan.input, null, 2));
  await writeFile(plan.sidecar, JSON.stringify(plan.input, null, 2) + '\n');
  console.log(`Uploaded bundle ${bundleId} (guid ${plan.input.guid}). Saved ${plan.sidecar}.`);

  if (flags.wait === false) return;
  const status = await waitForStatus(bucket, layout.inboxStatus(flags.show, bundleId));
  if (!status || status['status'] === 'processing') {
    console.log(`Still processing. Check later with: darkrelay bundle ${flags.show} ${bundleId}`);
    return;
  }
  reportStatus(status, flags.show);
}

export function reportStatus(status: Record<string, unknown>, show: string) {
  if (status['status'] !== 'published') {
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = 1;
    return;
  }
  if (typeof status['scheduledFor'] === 'string') {
    console.log(`Scheduled: releases ${describeTime(status['scheduledFor'])}.`);
    console.log(
      'It is not in the feed until then. See upcoming episodes with: darkrelay episodes ' + show,
    );
  } else {
    console.log(`Published. Feed ${status['feed']}.`);
  }
  if (status['feedErrors']) console.log(JSON.stringify(status['feedErrors'], null, 2));
}

/**
 * Waits for the publisher's verdict. Audio publishes in seconds; video first
 * goes through Fargate, which takes roughly the episode's length, so while
 * the status says "processing" this keeps waiting (up to 3 hours).
 */
async function waitForStatus(bucket: Bucket, key: string) {
  const start = Date.now();
  let deadline = start + 120_000;
  let announced = false;
  let lastNote = start;
  while (Date.now() < deadline) {
    const text = await bucket.getText(key);
    const status = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    if (status && status['status'] !== 'processing') return status;
    if (status && !announced) {
      announced = true;
      deadline = start + 3 * 3600_000;
      console.log(
        'Processing video on Fargate (roughly the length of the episode). Ctrl-C is safe; it keeps going.',
      );
    }
    if (announced && Date.now() - lastNote > 300_000) {
      lastNote = Date.now();
      console.log(`  still processing (${Math.round((Date.now() - start) / 60_000)} min)`);
    }
    await new Promise((r) => setTimeout(r, announced ? 15_000 : 3000));
  }
  return undefined;
}

/** Prints the result of an earlier upload. */
export async function bundleStatus(show: string, bundleId: string, global: GlobalOptions) {
  const { bucket: name } = await resolveDeployment(global);
  const text = await new Bucket(name).getText(layout.inboxStatus(show, bundleId));
  if (!text) {
    console.log('No result yet (or it expired after 30 days).');
    return;
  }
  const status = JSON.parse(text) as Record<string, unknown>;
  if (status['status'] === 'processing') console.log('Still processing video.');
  else reportStatus(status, show);
}
