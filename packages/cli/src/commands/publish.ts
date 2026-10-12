import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  EpisodeInput,
  classifyBundle,
  contentTypeFor,
  layout,
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
  video?: string;
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
 * Turns a bundle directory, or a bare audio file plus flags, into the files to
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
    files.push({ name: `audio${extname(target).toLowerCase()}`, path: target });
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
  extra('video', flags.video);

  const { files: roles, errors, ignored } = classifyBundle(files.map((f) => f.name));
  if (errors.length) throw new Error(errors.join('\n'));
  const upload = files.filter((f) => !ignored.includes(f.name));

  const base: Partial<EpisodeInputRaw> = await readFile(sidecar, 'utf8')
    .then((t) => JSON.parse(t) as Partial<EpisodeInputRaw>)
    .catch(() => ({}));
  const audioPath = upload.find((f) => f.name === roles.audio)!.path;
  const description = flags.notes
    ? await readFile(flags.notes, 'utf8')
    : (flags.description ?? base.description);
  const duration = base.durationSeconds ?? (await durationOf(audioPath));

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
  };
  const parsed = EpisodeInput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Episode details incomplete:\n${z.prettifyError(parsed.error)}`);
  }
  return { input: parsed.data, files: upload, sidecar };
}

export function newBundleId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
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
  if (!status) {
    console.log('Still processing. Check later with: darkrelay status ' + flags.show);
    return;
  }
  if (status['status'] !== 'published') {
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = 1;
    return;
  }
  if (typeof status['scheduledFor'] === 'string') {
    console.log(`Scheduled: releases ${describeTime(status['scheduledFor'])}.`);
    console.log(
      'It is not in the feed until then. See upcoming episodes with: darkrelay episodes ' +
        flags.show,
    );
  } else {
    console.log(`Published. Feed ${status['feed']}.`);
  }
  if (status['feedErrors']) console.log(JSON.stringify(status['feedErrors'], null, 2));
}

async function waitForStatus(bucket: Bucket, key: string, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const text = await bucket.getText(key);
    if (text) return JSON.parse(text) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
}
