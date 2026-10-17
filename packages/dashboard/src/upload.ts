import { get, post, type CreateUploadResponse, type MeResponse, type UploadStatus } from './api';
import type { RuntimeConfig } from './auth';
import {
  ACCEPT,
  bytes,
  localToIso,
  partRanges,
  planFiles,
  type Picked,
  type PlannedFile,
  type Slot,
} from './upload-plan';

/** Parts in flight per file. */
const CONCURRENCY = 4;
const ATTEMPTS = 4;
/** Part URLs expire after 15 minutes; sign again well before that. */
const URL_MAX_AGE_MS = 10 * 60_000;
const SIGN_BATCH = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function field(label: string, control: HTMLElement, hint?: string) {
  const wrap = el('label', undefined, 'field');
  wrap.append(el('span', label, 'field-label'), control);
  if (hint) wrap.append(el('span', hint, 'field-hint'));
  return wrap;
}

/** PUTs one part straight to S3. Returns the part's ETag. */
function putPart(url: string, body: Blob, onProgress: (loaded: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(etag ? `S3 returned HTTP ${xhr.status}` : 'S3 sent no ETag (CORS?)'));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(body);
  });
}

// One listener for the page: warn before leaving mid-upload.
let busy = false;
window.addEventListener('beforeunload', (e) => {
  if (busy) e.preventDefault();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FileJob {
  planned: PlannedFile;
  file: File;
  spec?: CreateUploadResponse['files'][number];
  /** Finished parts survive a failed attempt, so Retry resumes rather than restarts. */
  etags: Map<number, string>;
  done: boolean;
  row: HTMLLIElement;
  bar: HTMLProgressElement;
  note: HTMLSpanElement;
}

/** Sends a file's remaining parts, a few at a time, then completes it. */
async function sendFile(config: RuntimeConfig, base: string, job: FileJob) {
  const spec = job.spec!;
  const ranges = partRanges(job.file.size, spec.partSize, spec.partCount);
  const queue = ranges.filter((r) => !job.etags.has(r.partNumber));
  const urls = new Map<number, { url: string; at: number }>();
  const inFlight = new Map<number, number>();
  const doneBytes = () =>
    ranges.filter((r) => job.etags.has(r.partNumber)).reduce((n, r) => n + r.end - r.start, 0);
  const progress = () => {
    const sent = doneBytes() + [...inFlight.values()].reduce((a, b) => a + b, 0);
    job.bar.value = job.file.size ? sent / job.file.size : 1;
    job.note.textContent = `${bytes(sent)} of ${bytes(job.file.size)}`;
  };

  const urlFor = async (n: number) => {
    const cached = urls.get(n);
    if (cached && Date.now() - cached.at < URL_MAX_AGE_MS) return cached.url;
    // Sign this part and the next ones still waiting, in one call.
    const wanted = [n, ...queue.map((r) => r.partNumber)].slice(0, SIGN_BATCH);
    const { urls: signed } = await post<{ urls: Record<string, string> }>(config, `${base}/parts`, {
      name: spec.name,
      uploadId: spec.uploadId,
      parts: wanted,
    });
    for (const [k, url] of Object.entries(signed)) urls.set(Number(k), { url, at: Date.now() });
    return urls.get(n)!.url;
  };

  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      for (let attempt = 1; ; attempt++) {
        try {
          const etag = await putPart(
            await urlFor(r.partNumber),
            job.file.slice(r.start, r.end),
            (loaded) => {
              inFlight.set(r!.partNumber, loaded);
              progress();
            },
          );
          job.etags.set(r.partNumber, etag);
          break;
        } catch (e) {
          urls.delete(r.partNumber);
          if (attempt >= ATTEMPTS) throw e;
          await sleep(1000 * 2 ** attempt);
        } finally {
          inFlight.delete(r.partNumber);
          progress();
        }
      }
    }
  };
  progress();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  await post(config, `${base}/files`, {
    name: spec.name,
    uploadId: spec.uploadId,
    parts: [...job.etags].map(([partNumber, etag]) => ({ partNumber, etag })),
  });
  job.done = true;
  job.bar.value = 1;
  job.note.textContent = `${bytes(job.file.size)}, uploaded`;
}

/** Length in seconds as the browser reads it, or undefined if it can't. */
function mediaDuration(file: File) {
  return new Promise<number | undefined>((resolve) => {
    const media = document.createElement(
      file.name.toLowerCase().endsWith('.mp4') ? 'video' : 'audio',
    );
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (v: number | undefined) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(v);
    };
    media.preload = 'metadata';
    media.onloadedmetadata = () =>
      done(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined);
    media.onerror = () => done(undefined);
    setTimeout(() => done(undefined), 15_000);
    media.src = url;
  });
}

/** "1:02:03", "62:03" or "3723" to seconds. */
function parseLength(text: string): number | undefined {
  const parts = text.trim().split(':').map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0))
    return undefined;
  const s = parts.reduce((acc, n) => acc * 60 + n, 0);
  return s > 0 ? s : undefined;
}

function describeRelease(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function statusView(status: UploadStatus, show: string) {
  const box = el('div', undefined, 'upload-status');
  switch (status.status) {
    case 'uploading':
    case 'queued':
      box.append(el('p', 'Queued for publishing…'));
      break;
    case 'processing':
      box.append(
        el(
          'p',
          'Processing the video. This takes roughly the length of the episode; you can leave this page and it keeps going.',
        ),
      );
      break;
    case 'published': {
      box.append(
        el(
          'p',
          status.scheduledFor
            ? `Scheduled. It releases ${describeRelease(status.scheduledFor)} and is not in the feed until then.`
            : 'Published. It is in the feed now.',
          'ok',
        ),
      );
      if (status.feed === 'invalid')
        box.append(
          el('p', 'The feed has validation errors; run darkrelay status to see them.', 'error'),
        );
      const back = el('a', 'Back to the show');
      back.href = `#/s/${show}`;
      box.append(back);
      break;
    }
    case 'rejected': {
      box.append(el('p', 'Rejected. Nothing was published:', 'error'));
      const list = el('ul', undefined, 'error');
      for (const e of status.errors ?? []) list.append(el('li', e));
      box.append(list);
      break;
    }
  }
  return box;
}

/** Polls the publisher's verdict until it's final or the view goes away. */
async function watch(config: RuntimeConfig, show: string, bundleId: string, out: HTMLElement) {
  const start = Date.now();
  while (out.isConnected && Date.now() - start < 3 * 3600_000) {
    let status: UploadStatus | undefined;
    try {
      status = await get<UploadStatus>(config, `/shows/${show}/uploads/${bundleId}`);
      out.replaceChildren(statusView(status, show));
      if (status.status === 'published' || status.status === 'rejected') return;
    } catch (e) {
      out.replaceChildren(el('p', `Couldn't check the status: ${(e as Error).message}`, 'error'));
    }
    await sleep(status?.status === 'processing' ? 15_000 : 3000);
  }
}

/** The upload form, for shows the user can upload to (checked again server-side). */
export async function uploadView(app: HTMLElement, config: RuntimeConfig, preset?: string) {
  const me = await get<MeResponse>(config, '/me');
  if (!me.upload.length) {
    app.replaceChildren(
      el('h1', 'Upload episode'),
      el(
        'p',
        "You don't have upload access to any show. Ask an admin to give you the uploader role.",
        'muted',
      ),
    );
    return;
  }

  const form = el('form', undefined, 'card upload-form');
  form.noValidate = true;
  const fields = el('fieldset', undefined, 'plain');

  const show = el('select');
  show.required = true;
  for (const s of me.upload) show.add(new Option(s.title, s.show, false, s.show === preset));

  const title = el('input');
  title.required = true;
  const notes = el('textarea');
  notes.rows = 8;
  notes.required = true;

  const now = el('input');
  now.type = 'radio';
  now.name = 'release';
  now.checked = true;
  const later = el('input');
  later.type = 'radio';
  later.name = 'release';
  const when = el('input');
  when.type = 'datetime-local';
  when.disabled = true;
  for (const r of [now, later]) r.addEventListener('change', () => (when.disabled = now.checked));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const release = el('fieldset', undefined, 'field');
  const nowLabel = el('label', undefined, 'inline');
  nowLabel.append(now, ' Now');
  const laterLabel = el('label', undefined, 'inline');
  laterLabel.append(later, ' At ', when);
  release.append(
    el('legend', 'Release'),
    nowLabel,
    laterLabel,
    el('span', `Your time zone: ${zone}`, 'field-hint'),
  );

  const number = () => {
    const i = el('input');
    i.type = 'number';
    i.min = '1';
    i.step = '1';
    i.inputMode = 'numeric';
    return i;
  };
  const season = number();
  const episode = number();
  const type = el('select');
  for (const t of ['full', 'trailer', 'bonus'])
    type.add(new Option(t[0]!.toUpperCase() + t.slice(1), t));
  const explicit = el('input');
  explicit.type = 'checkbox';
  const explicitLabel = el('label', undefined, 'inline');
  explicitLabel.append(explicit, ' Explicit');
  const row = el('div', undefined, 'field-row');
  row.append(field('Season', season), field('Episode', episode), field('Type', type));

  const pickers: Record<Slot, HTMLInputElement> = {} as Record<Slot, HTMLInputElement>;
  const picker = (slot: Slot) => {
    const i = el('input');
    i.type = 'file';
    i.accept = ACCEPT[slot];
    pickers[slot] = i;
    return i;
  };
  const files = el('fieldset', undefined, 'field');
  files.append(
    el('legend', 'Files'),
    field('Audio or video', picker('media'), 'MP3 or M4A for audio; MP4 for a video episode'),
    field('Transcript', picker('transcript'), 'Optional. VTT, SRT or Podcasting 2.0 JSON'),
    field('Chapters', picker('chapters'), 'Optional. Podcasting 2.0 JSON'),
    field('Episode artwork', picker('cover'), 'Optional. JPEG or PNG'),
    field('Audiogram video', picker('audiogram'), 'Optional, audio episodes only. MP4 for YouTube'),
  );

  const length = el('input');
  length.placeholder = '1:02:03';
  const lengthField = field(
    'Length',
    length,
    "This browser couldn't read the file's length. Enter it as h:mm:ss.",
  );
  lengthField.hidden = true;

  const errors = el('div', undefined, 'error');
  errors.setAttribute('role', 'alert');
  const submit = el('button', 'Upload and publish', 'primary');
  submit.type = 'submit';

  fields.append(
    field('Show', show),
    field('Title', title),
    field('Show notes', notes, 'HTML, as in the feed'),
    release,
    row,
    explicitLabel,
    files,
    lengthField,
  );
  form.append(fields, errors, submit);

  const progress = el('section', undefined, 'card upload-progress');
  progress.hidden = true;
  const fileList = el('ul', undefined, 'upload-files');
  const result = el('div');
  const retry = el('button', 'Retry', 'primary');
  retry.type = 'button';
  retry.hidden = true;
  progress.append(el('h2', 'Upload'), fileList, retry, result);

  const back = el('a', '← Back', 'back');
  back.href = `#/s/${preset ?? ''}`;
  app.replaceChildren(back, el('h1', 'Upload episode'), form, progress);

  const showErrors = (list: string[]) => {
    errors.replaceChildren(...list.map((e) => el('p', e)));
    if (list.length) errors.scrollIntoView({ block: 'nearest' });
  };

  // Set once the bundle is created; Retry picks up from wherever it stopped.
  let state: { slug: string; bundleId: string; jobs: FileJob[]; duration: number } | undefined;

  /** Episode details from the form, or the problems with them. */
  const details = (duration: number) => {
    const problems: string[] = [];
    if (!title.value.trim()) problems.push('Add a title.');
    if (!notes.value.trim()) problems.push('Add show notes.');
    const pubDate = later.checked ? localToIso(when.value) : undefined;
    if (later.checked && !pubDate) problems.push('Choose a release date and time.');
    for (const [input, label] of [
      [season, 'Season'],
      [episode, 'Episode'],
    ] as const) {
      if (input.value && !(Number.isInteger(Number(input.value)) && Number(input.value) > 0))
        problems.push(`${label} must be a whole number above 0.`);
    }
    return {
      problems,
      body: {
        title: title.value,
        description: notes.value,
        pubDate,
        durationSeconds: duration,
        season: season.value ? Number(season.value) : undefined,
        episode: episode.value ? Number(episode.value) : undefined,
        episodeType: type.value,
        explicit: explicit.checked || undefined,
      },
    };
  };

  const run = async () => {
    const s = state!;
    const base = `/shows/${s.slug}/uploads/${s.bundleId}`;
    const { problems, body } = details(s.duration);
    if (problems.length) return showErrors(problems);
    showErrors([]);
    busy = true;
    retry.hidden = true;
    fields.disabled = true;
    result.replaceChildren();
    try {
      for (const job of s.jobs) {
        if (job.done) continue;
        job.row.classList.remove('failed');
        await sendFile(config, base, job).catch((e: unknown) => {
          job.row.classList.add('failed');
          job.note.textContent = `Failed: ${(e as Error).message}`;
          throw e;
        });
      }
      await post(config, `${base}/complete`, body);
      busy = false;
      await watch(config, s.slug, s.bundleId, result);
    } catch (e) {
      busy = false;
      result.replaceChildren(el('p', (e as Error).message, 'error'));
      retry.hidden = false;
      // Files are in; the details can still be fixed before trying again.
      if (s.jobs.every((j) => j.done)) {
        fields.disabled = false;
        show.disabled = true;
        for (const input of Object.values(pickers)) input.disabled = true;
      }
    }
  };
  retry.addEventListener('click', () => void run());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked: (Picked & { file: File })[] = [];
    for (const [slot, input] of Object.entries(pickers) as [Slot, HTMLInputElement][]) {
      const file = input.files?.[0];
      if (file) picked.push({ slot, file });
    }
    const plan = planFiles(picked);
    const problems = [...plan.errors, ...details(0).problems];
    if (problems.length) return showErrors(problems);

    const media = picked.find((p) => p.slot === 'media')!.file;
    let duration = lengthField.hidden ? undefined : parseLength(length.value);
    if (lengthField.hidden) {
      submit.disabled = true;
      submit.textContent = 'Reading the file…';
      duration = await mediaDuration(media);
      submit.disabled = false;
      submit.textContent = 'Upload and publish';
      if (duration === undefined) {
        lengthField.hidden = false;
        length.focus();
        return showErrors([`Couldn't read the length of ${media.name}. Enter it below.`]);
      }
    }
    if (duration === undefined) return showErrors(['Enter the length as h:mm:ss.']);
    showErrors([]);

    fields.disabled = true;
    submit.hidden = true;
    progress.hidden = false;
    const slug = show.value;
    try {
      const created = await post<CreateUploadResponse>(config, `/shows/${slug}/uploads`, {
        files: plan.files.map((f) => ({ name: f.name, size: f.size })),
      });
      const jobs = plan.files.map((planned, i): FileJob => {
        const row = el('li');
        const bar = el('progress');
        bar.max = 1;
        bar.value = 0;
        const note = el('span', 'Waiting', 'muted');
        row.append(el('span', `${picked[i]!.file.name} → ${planned.name}`, 'file-name'), bar, note);
        fileList.append(row);
        return {
          planned,
          file: picked[i]!.file,
          spec: created.files.find((f) => f.name === planned.name),
          etags: new Map(),
          done: false,
          row,
          bar,
          note,
        };
      });
      state = { slug, bundleId: created.bundleId, jobs, duration };
    } catch (err) {
      // Nothing uploaded yet: let them fix the form and try again.
      fields.disabled = false;
      submit.hidden = false;
      progress.hidden = true;
      return showErrors([(err as Error).message]);
    }
    await run();
  });
}
