import {
  get,
  post,
  type CatalogResponse,
  type CreateUploadResponse,
  type EpisodeDetails,
  type MeResponse,
  type UploadStatus,
} from './api';
import type { RuntimeConfig } from './auth';
import {
  ACCEPT,
  isoToLocal,
  localToIso,
  planFiles,
  type Picked,
  type PlannedFile,
  type Slot,
} from './upload-plan';
import { sendAll, setBusy, sleep, type FileJob as Transfer } from './transfer';

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

interface FileJob extends Transfer {
  planned: PlannedFile;
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

/** `hidden`: an edit that leaves the episode out of the feed. */
type Mode = 'new' | 'edit' | 'hidden';

function statusView(status: UploadStatus, show: string, mode: Mode) {
  const edit = mode !== 'new';
  const box = el('div', undefined, 'upload-status');
  switch (status.status) {
    case 'uploading':
    case 'queued':
      box.append(el('p', edit ? 'Saving…' : 'Queued for publishing…'));
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
      const when =
        mode === 'hidden'
          ? 'It is hidden from the feed.'
          : status.scheduledFor
            ? `It releases ${describeRelease(status.scheduledFor)} and is not in the feed until then.`
            : 'It is in the feed now.';
      box.append(
        el(
          'p',
          `${edit ? 'Saved.' : status.scheduledFor ? 'Scheduled.' : 'Published.'} ${when}`,
          'ok',
        ),
      );
      if (status.feed === 'invalid')
        box.append(
          el('p', 'The feed has validation errors; run darkrelay status to see them.', 'error'),
        );
      const back = el('a', edit ? 'Back to the episodes' : 'Back to the show');
      back.href = edit ? `#/manage/${show}` : `#/s/${show}`;
      box.append(back);
      break;
    }
    case 'rejected': {
      box.append(el('p', `Rejected. Nothing was ${edit ? 'changed' : 'published'}:`, 'error'));
      const list = el('ul', undefined, 'error');
      for (const e of status.errors ?? []) list.append(el('li', e));
      box.append(list);
      break;
    }
  }
  return box;
}

/** Polls the publisher's verdict until it's final or the view goes away. */
async function watch(
  config: RuntimeConfig,
  show: string,
  bundleId: string,
  out: HTMLElement,
  mode: Mode,
) {
  const start = Date.now();
  while (out.isConnected && Date.now() - start < 3 * 3600_000) {
    let status: UploadStatus | undefined;
    try {
      status = await get<UploadStatus>(config, `/shows/${show}/uploads/${bundleId}`);
      out.replaceChildren(statusView(status, show, mode));
      if (status.status === 'published' || status.status === 'rejected') return;
    } catch (e) {
      out.replaceChildren(el('p', `Couldn't check the status: ${(e as Error).message}`, 'error'));
    }
    await sleep(status?.status === 'processing' ? 15_000 : 3000);
  }
}

const STATE_LABEL = { live: 'Live', scheduled: 'Scheduled', hidden: 'Hidden' } as const;

/** Every episode of a show, including scheduled and hidden ones, to pick one to edit. */
export async function manageView(app: HTMLElement, config: RuntimeConfig, show: string) {
  const [me, data] = await Promise.all([
    get<MeResponse>(config, '/me'),
    get<CatalogResponse>(config, `/shows/${show}/catalog`),
  ]);
  const title = me.upload.find((s) => s.show === show)?.title ?? show;
  const back = el('a', '← Analytics', 'back');
  back.href = `#/s/${show}`;
  const heading = el('div', undefined, 'heading');
  const up = el('a', 'Upload episode', 'button');
  up.href = `#/upload/${show}`;
  heading.append(el('h1', `${title}: episodes`), up);

  const table = el('table', undefined, 'catalog');
  const head = table.createTHead().insertRow();
  for (const h of ['Episode', 'Release', 'State']) head.append(el('th', h));
  const body = table.createTBody();
  for (const e of data.episodes) {
    const tr = body.insertRow();
    const a = el('a', e.title);
    a.href = `#/edit/${show}/${e.episodeId}`;
    tr.insertCell().append(a);
    tr.insertCell().textContent = describeRelease(e.pubDate);
    tr.insertCell().append(el('span', STATE_LABEL[e.state], `badge ${e.state}`));
  }
  const wrap = el('div', undefined, 'scroll-x');
  wrap.append(table);
  const section = el('section', undefined, 'card');
  section.append(data.episodes.length ? wrap : el('p', 'No episodes yet.', 'muted'));
  app.replaceChildren(back, heading, section);
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
  episodeForm(app, config, { shows: me.upload, preset });
}

/** Edits an existing episode: its details, and optionally some of its files. */
export async function editView(
  app: HTMLElement,
  config: RuntimeConfig,
  show: string,
  episodeId: string,
) {
  const episode = await get<EpisodeDetails>(config, `/shows/${show}/catalog/${episodeId}`);
  episodeForm(app, config, { shows: [{ show, title: show }], preset: show, episode });
}

function describeFiles(f: EpisodeDetails['files']) {
  const parts = [f.audio === 'audio/mp4' ? 'M4A audio' : 'MP3 audio'];
  if (f.video) parts.push('video');
  for (const t of f.transcripts)
    parts.push(`${t.split('/').pop()!.replace('x-subrip', 'SRT').toUpperCase()} transcript`);
  if (f.chapters) parts.push('chapters');
  if (f.cover) parts.push('artwork');
  if (f.thumbnail) parts.push('YouTube thumbnail');
  return parts.join(', ');
}

/**
 * One form for both a new episode and an edit. An edit sends only the files
 * picked; the publisher keeps the rest, exactly as with a CLI re-publish.
 */
function episodeForm(
  app: HTMLElement,
  config: RuntimeConfig,
  opts: { shows: { show: string; title: string }[]; preset?: string; episode?: EpisodeDetails },
) {
  const existing = opts.episode;
  const edit = existing !== undefined;
  const form = el('form', undefined, 'card upload-form');
  form.noValidate = true;
  const fields = el('fieldset', undefined, 'plain');

  const show = el('select');
  show.required = true;
  for (const s of opts.shows) show.add(new Option(s.title, s.show, false, s.show === opts.preset));

  const title = el('input');
  title.required = true;
  title.value = existing?.title ?? '';
  const notes = el('textarea');
  notes.rows = 8;
  notes.required = true;
  notes.value = existing?.description ?? '';

  const now = el('input');
  now.type = 'radio';
  now.name = 'release';
  const later = el('input');
  later.type = 'radio';
  later.name = 'release';
  const when = el('input');
  when.type = 'datetime-local';
  if (existing) {
    later.checked = true;
    when.value = isoToLocal(existing.pubDate);
  } else {
    now.checked = true;
    when.disabled = true;
  }
  for (const r of [now, later]) r.addEventListener('change', () => (when.disabled = now.checked));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const release = el('fieldset', undefined, 'field');
  const nowLabel = el('label', undefined, 'inline');
  nowLabel.append(now, ' Now');
  const laterLabel = el('label', undefined, 'inline');
  laterLabel.append(later, ' At ', when);
  // Taking a released episode back out of the feed needs saying out loud.
  const confirm = el('input');
  confirm.type = 'checkbox';
  const confirmLabel = el('label', undefined, 'inline confirm');
  confirmLabel.append(confirm, ' This episode is already out. Take it out of the feed until then.');
  confirmLabel.hidden = true;
  release.append(
    el('legend', 'Release'),
    nowLabel,
    laterLabel,
    el('span', `Your time zone: ${zone}`, 'field-hint'),
    confirmLabel,
  );

  const number = (value?: number) => {
    const i = el('input');
    i.type = 'number';
    i.min = '1';
    i.step = '1';
    i.inputMode = 'numeric';
    i.value = value === undefined ? '' : String(value);
    return i;
  };
  const season = number(existing?.season);
  const episode = number(existing?.episode);
  const type = el('select');
  for (const t of ['full', 'trailer', 'bonus'])
    type.add(new Option(t[0]!.toUpperCase() + t.slice(1), t, false, t === existing?.episodeType));
  const explicit = el('input');
  explicit.type = 'checkbox';
  explicit.checked = existing?.explicit ?? false;
  const explicitLabel = el('label', undefined, 'inline');
  explicitLabel.append(explicit, ' Explicit');
  const hidden = el('input');
  hidden.type = 'checkbox';
  hidden.checked = existing?.status === 'hidden';
  const hiddenLabel = el('label', undefined, 'inline');
  hiddenLabel.append(hidden, ' Hidden from the feed');
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
  const optional = edit ? 'Replaces the current one. ' : 'Optional. ';
  const files = el('fieldset', undefined, 'field');
  files.append(el('legend', edit ? 'Replace files' : 'Files'));
  if (existing)
    files.append(
      el(
        'p',
        `Now: ${describeFiles(existing.files)}. Choose only what you want to replace; the rest stays.`,
        'field-hint',
      ),
    );
  files.append(
    field(
      'Audio or video',
      picker('media'),
      edit
        ? 'Replaces the episode audio (or video). The YouTube video is not re-uploaded.'
        : 'MP3 or M4A for audio; MP4 for a video episode',
    ),
    field('Transcript', picker('transcript'), `${optional}VTT, SRT or Podcasting 2.0 JSON`),
    field('Chapters', picker('chapters'), `${optional}Podcasting 2.0 JSON`),
    field('Episode artwork', picker('cover'), `${optional}Square JPEG or PNG, 1400-3000 px`),
    field(
      'YouTube thumbnail',
      picker('thumbnail'),
      `${optional}16:9 JPEG or PNG, 1280×720, under 2 MB. Without one, YouTube gets the artwork`,
    ),
    field(
      'Audiogram video',
      picker('audiogram'),
      `${optional}Audio episodes only. MP4 for YouTube`,
    ),
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
  const label = edit ? 'Save changes' : 'Upload and publish';
  const submit = el('button', label, 'primary');
  submit.type = 'submit';

  fields.append(
    ...(edit ? [] : [field('Show', show)]),
    field('Title', title),
    field('Show notes', notes, 'HTML, as in the feed'),
    release,
    row,
    explicitLabel,
    ...(edit ? [hiddenLabel] : []),
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
  progress.append(el('h2', edit ? 'Saving' : 'Upload'), fileList, retry, result);

  const back = el('a', '← Back', 'back');
  back.href = edit ? `#/manage/${opts.preset}` : `#/s/${opts.preset ?? ''}`;
  app.replaceChildren(back, el('h1', edit ? 'Edit episode' : 'Upload episode'), form, progress);

  const showErrors = (list: string[]) => {
    errors.replaceChildren(...list.map((e) => el('p', e)));
    if (list.length) errors.scrollIntoView({ block: 'nearest' });
  };

  // Set once the bundle is created; Retry picks up from wherever it stopped.
  let state:
    { slug: string; bundleId: string; jobs: FileJob[]; duration: number | undefined } | undefined;

  /** Episode details from the form, or the problems with them. */
  const details = (duration: number | undefined) => {
    const problems: string[] = [];
    if (!title.value.trim()) problems.push('Add a title.');
    if (!notes.value.trim()) problems.push('Add show notes.');
    // "Now" on an edit releases it now; on a new episode the publisher stamps the time.
    const pubDate = later.checked
      ? localToIso(when.value)
      : edit
        ? new Date().toISOString()
        : undefined;
    if (later.checked && !pubDate) problems.push('Choose a release date and time.');
    const pullsBack =
      existing?.state === 'live' && pubDate !== undefined && Date.parse(pubDate) > Date.now();
    confirmLabel.hidden = !pullsBack;
    if (pullsBack && !confirm.checked)
      problems.push('This episode is already out: confirm taking it out of the feed until then.');
    for (const [input, name] of [
      [season, 'Season'],
      [episode, 'Episode'],
    ] as const) {
      if (input.value && !(Number.isInteger(Number(input.value)) && Number(input.value) > 0))
        problems.push(`${name} must be a whole number above 0.`);
    }
    return {
      problems,
      body: {
        episodeId: existing?.episodeId,
        title: title.value,
        description: notes.value,
        pubDate,
        durationSeconds: duration,
        season: season.value ? Number(season.value) : undefined,
        episode: episode.value ? Number(episode.value) : undefined,
        episodeType: type.value,
        explicit: edit ? explicit.checked : explicit.checked || undefined,
        status: edit ? (hidden.checked ? 'hidden' : 'published') : undefined,
        force: pullsBack || undefined,
      },
    };
  };

  const run = async () => {
    const s = state!;
    const base = `/shows/${s.slug}/uploads/${s.bundleId}`;
    const { problems, body } = details(s.duration);
    if (problems.length) return showErrors(problems);
    showErrors([]);
    setBusy(true);
    retry.hidden = true;
    fields.disabled = true;
    result.replaceChildren();
    try {
      await sendAll(config, base, s.jobs);
      await post(config, `${base}/complete`, body);
      setBusy(false);
      const mode = !edit ? 'new' : hidden.checked ? 'hidden' : 'edit';
      await watch(config, s.slug, s.bundleId, result, mode);
    } catch (e) {
      setBusy(false);
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
    const plan = planFiles(picked, { update: edit });
    const problems = [...plan.errors, ...details(undefined).problems];
    if (problems.length) return showErrors(problems);

    // New media brings a new length; an edit without it keeps the episode's.
    const media = picked.find((p) => p.slot === 'media')?.file;
    let duration: number | undefined;
    if (media && lengthField.hidden) {
      submit.disabled = true;
      submit.textContent = 'Reading the file…';
      duration = await mediaDuration(media);
      submit.disabled = false;
      submit.textContent = label;
      if (duration === undefined) {
        lengthField.hidden = false;
        length.focus();
        return showErrors([`Couldn't read the length of ${media.name}. Enter it below.`]);
      }
    } else if (media) {
      duration = parseLength(length.value);
      if (duration === undefined) return showErrors(['Enter the length as h:mm:ss.']);
    }
    showErrors([]);

    fields.disabled = true;
    submit.hidden = true;
    progress.hidden = false;
    const slug = show.value;
    try {
      const created = await post<CreateUploadResponse>(config, `/shows/${slug}/uploads`, {
        files: plan.files.map((f) => ({ name: f.name, size: f.size })),
        episodeId: existing?.episodeId,
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
