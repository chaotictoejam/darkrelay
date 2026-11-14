import {
  canManage,
  get,
  post,
  type BatchStatus,
  type CreateBatchResponse,
  type MeResponse,
  type ShortsFormContext,
  type ShowsResponse,
} from './api';
import type { RuntimeConfig } from './auth';
import { shortDate, slotTime } from './format';
import { slotEditor } from './reschedule';
import {
  ACCEPT_BATCH,
  batchName,
  buildBatch,
  isImage,
  isVideo,
  titleFromName,
  type ClipInput,
} from './shorts-plan';
import { sendAll, setBusy, sleep, type FileJob } from './transfer';
import { el, link } from './ui';
import { bytes } from './upload-plan';

/**
 * Uploading a batch of Shorts from the browser: the same thing
 * `darkrelay shorts put` does with a directory, with the manifest written
 * from the form instead of by hand. Nothing reaches YouTube here — each clip
 * goes up a few days before its slot — so the page says so plainly rather
 * than letting anyone think they just published.
 */

function field(label: string, control: HTMLElement, hint?: string) {
  const wrap = el('label', undefined, 'field');
  wrap.append(el('span', label, 'field-label'), control);
  if (hint) wrap.append(el('span', hint, 'field-hint'));
  return wrap;
}

/** One clip's row: the file it came from, and the inputs that describe it. */
interface ClipRow {
  file: File;
  /** Name inside the batch, which the manifest points at. */
  name: string;
  row: HTMLElement;
  title: HTMLInputElement;
  description: HTMLTextAreaElement;
  tags: HTMLInputElement;
  parent: HTMLSelectElement;
  thumbnail: HTMLSelectElement;
  slot: HTMLInputElement;
  removed: boolean;
}

const read = (clip: ClipRow): ClipInput => ({
  name: clip.name,
  title: clip.title.value,
  description: clip.description.value,
  tags: clip.tags.value,
  parentId: clip.parent.value,
  thumbnail: clip.thumbnail.value,
  slot: clip.slot.value,
});

/** The brands a Short can be uploaded to: every brand the user may upload to. */
export async function shortsUploadView(app: HTMLElement, config: RuntimeConfig, brand?: string) {
  const me = await get<MeResponse>(config, '/me');
  const slugs = me.manage ?? me.upload.map((s) => s.show);
  if (!slugs.length) {
    app.replaceChildren(
      el('h1', 'Upload Shorts'),
      el(
        'p',
        "You don't have upload access to any brand. Ask an admin for the uploader role.",
        'muted',
      ),
    );
    return;
  }
  if (!brand) {
    const { shows } = await get<ShowsResponse>(config, '/shows');
    const list = el('ul', undefined, 'brands');
    for (const slug of slugs) {
      const li = el('li');
      const title = shows.find((s) => s.show === slug)?.title ?? slug;
      li.append(link(`#/shorts/${slug}`, title));
      list.append(li);
    }
    app.replaceChildren(el('h1', 'Upload Shorts'), el('p', 'Which brand?', 'muted'), list);
    return;
  }
  if (!canManage(me, brand)) {
    app.replaceChildren(
      el('h1', 'Upload Shorts'),
      el('p', `You don't have upload access to ${brand}.`, 'muted'),
    );
    return;
  }
  const context = await get<ShortsFormContext>(config, `/brands/${brand}/shorts`);
  batchForm(app, config, context);
}

function batchForm(app: HTMLElement, config: RuntimeConfig, context: ShortsFormContext) {
  const brand = context.brand;
  const clips: ClipRow[] = [];
  /** Images picked but not yet used: any clip may name one as its thumbnail. */
  const images = new Map<string, File>();
  const taken = new Set<string>();

  const form = el('form', undefined, 'card upload-form');
  form.noValidate = true;
  const fields = el('fieldset', undefined, 'plain');

  const kind = el('select');
  for (const [value, label] of [
    ['short', 'Shorts (vertical, under 3 minutes)'],
    ['video', 'Videos (long-form)'],
  ] as const) {
    kind.add(new Option(label, value));
  }

  const outlet = el('select');
  outlet.add(new Option('The brand’s first channel', ''));
  for (const o of context.outlets) outlet.add(new Option(o.label, o.id));
  const outletField = field('Channel', outlet);
  if (context.outlets.length < 2) outletField.hidden = true;

  const sharedNotes = el('textarea');
  sharedNotes.rows = 4;
  const sharedTags = el('input');
  sharedTags.placeholder = 'git, code review';

  const picker = el('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.accept = ACCEPT_BATCH;

  const clipList = el('ul', undefined, 'clip-list');
  const imageNote = el('p', undefined, 'field-hint');
  const empty = el(
    'p',
    'No clips yet. Pick the video files; any JPEG or PNG you pick with them can be used as a thumbnail.',
    'muted',
  );

  const errors = el('div', undefined, 'error');
  errors.setAttribute('role', 'alert');
  const submit = el('button', 'Upload', 'primary');
  submit.type = 'submit';

  const zone = context.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  /** Refreshes the thumbnail choices and the submit label after any change. */
  const refresh = () => {
    const live = clips.filter((c) => !c.removed);
    for (const clip of live) {
      const chosen = clip.thumbnail.value;
      clip.thumbnail.replaceChildren();
      clip.thumbnail.add(new Option('None', ''));
      for (const name of images.keys()) clip.thumbnail.add(new Option(name, name));
      clip.thumbnail.value = images.has(chosen) ? chosen : '';
    }
    imageNote.textContent = images.size
      ? `Thumbnails available: ${[...images.keys()].join(', ')}`
      : 'Pick a JPEG or PNG alongside the clips to use it as a thumbnail.';
    imageNote.hidden = !live.length;
    empty.hidden = live.length > 0;
    submit.textContent = live.length
      ? `Upload ${live.length} ${kind.value === 'video' ? 'video' : 'Short'}${live.length > 1 ? 's' : ''}`
      : 'Upload';
  };

  const addClip = (file: File) => {
    const name = batchName(file.name, taken);
    const row = el('li', undefined, 'clip');
    const head = el('div', undefined, 'clip-head');
    const remove = el('button', 'Remove', 'link-button');
    remove.type = 'button';
    head.append(el('span', file.name, 'file-name'), el('span', bytes(file.size), 'muted'), remove);

    const title = el('input');
    title.value = titleFromName(file.name);
    const description = el('textarea');
    description.rows = 3;
    description.placeholder = 'Uses the shared description';
    const tags = el('input');
    tags.placeholder = 'Uses the shared tags';
    const parent = el('select');
    parent.add(new Option('Nothing — a standalone clip', ''));
    for (const e of context.episodes) {
      parent.add(new Option(`${shortDate(e.pubDate)} — ${e.title}`, e.episodeId));
    }
    const thumbnail = el('select');
    const slot = el('input');
    slot.type = 'datetime-local';

    const grid = el('div', undefined, 'clip-fields');
    grid.append(
      field('Title', title),
      field('Description', description),
      field('Tags', tags, 'Comma-separated'),
      field('Clipped from', parent),
      field('Thumbnail', thumbnail),
      field('Slot', slot, `Optional. ${zone}. Leave empty and the planner can place it`),
    );
    row.append(head, grid);

    const clip: ClipRow = {
      file,
      name,
      row,
      title,
      description,
      tags,
      parent,
      thumbnail,
      slot,
      removed: false,
    };
    remove.addEventListener('click', () => {
      clip.removed = true;
      taken.delete(name);
      row.remove();
      refresh();
    });
    clips.push(clip);
    clipList.append(row);
  };

  picker.addEventListener('change', () => {
    const picked = [...(picker.files ?? [])];
    for (const file of picked) {
      if (isVideo(file.name)) addClip(file);
      else if (isImage(file.name)) images.set(batchName(file.name, taken), file);
    }
    // The picker is emptied so the same file can be picked again after a Remove.
    picker.value = '';
    refresh();
  });
  kind.addEventListener('change', refresh);

  const files = el('fieldset', undefined, 'field');
  files.append(
    el('legend', 'Clips'),
    field('Video files', picker, `Up to ${context.maxFiles} files in one batch`),
    imageNote,
    empty,
    clipList,
  );

  fields.append(
    field('Kind', kind),
    outletField,
    field(
      'Shared description',
      sharedNotes,
      'Used for every clip that has none of its own. Plain text, as YouTube shows it',
    ),
    field('Shared tags', sharedTags, 'Comma-separated'),
    files,
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

  const back = link(`#/s/${brand}`, '← Back');
  back.className = 'back';
  app.replaceChildren(
    back,
    el('h1', 'Upload Shorts'),
    el(
      'p',
      `${context.title}. Nothing goes to YouTube now: each clip is uploaded a few days before its slot, as a private video that YouTube makes public at that moment.`,
      'muted',
    ),
    form,
    progress,
  );
  refresh();

  const showErrors = (list: string[]) => {
    errors.replaceChildren(...list.map((e) => el('p', e)));
    if (list.length) errors.scrollIntoView({ block: 'nearest' });
  };

  // Set once the batch is open; Retry picks up from wherever it stopped.
  let state: { batchId: string; jobs: FileJob[]; body: unknown } | undefined;

  const run = async () => {
    const s = state!;
    const base = `/brands/${brand}/shorts/${s.batchId}`;
    setBusy(true);
    retry.hidden = true;
    fields.disabled = true;
    result.replaceChildren();
    try {
      await sendAll(config, base, s.jobs);
      await post(config, `${base}/complete`, s.body);
      setBusy(false);
      // A rejected batch wrote nothing and is sealed: the form comes back for
      // editing, and the next attempt opens a batch of its own.
      await watch(config, brand, s.batchId, result, () => {
        state = undefined;
        fields.disabled = false;
        submit.hidden = false;
        retry.hidden = true;
      });
    } catch (e) {
      setBusy(false);
      result.replaceChildren(el('p', (e as Error).message, 'error'));
      retry.hidden = false;
    }
  };
  retry.addEventListener('click', () => void run());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const live = clips.filter((c) => !c.removed);
    const { body, errors: problems } = buildBatch(live.map(read), {
      kind: kind.value as 'short' | 'video',
      outlet: outlet.value,
      description: sharedNotes.value,
      tags: sharedTags.value,
    });
    // Only the thumbnails a clip actually names are uploaded, so they are
    // what counts against the batch limit — not every image that was picked.
    const wanted = new Set(body.shorts.map((s) => s.thumbnail).filter(Boolean) as string[]);
    if (live.length + wanted.size > context.maxFiles)
      problems.push(`A batch holds up to ${context.maxFiles} files, thumbnails included.`);
    if (problems.length) return showErrors(problems);
    showErrors([]);

    const uploads: { name: string; file: File }[] = [
      ...live.map((c) => ({ name: c.name, file: c.file })),
      ...[...images].filter(([name]) => wanted.has(name)).map(([name, file]) => ({ name, file })),
    ];

    fields.disabled = true;
    submit.hidden = true;
    progress.hidden = false;
    fileList.replaceChildren();
    try {
      const created = await post<CreateBatchResponse>(config, `/brands/${brand}/shorts`, {
        files: uploads.map((u) => ({ name: u.name, size: u.file.size })),
      });
      const jobs = uploads.map(({ name, file }): FileJob => {
        const row = el('li');
        const bar = el('progress');
        bar.max = 1;
        bar.value = 0;
        const note = el('span', 'Waiting', 'muted');
        row.append(el('span', name, 'file-name'), bar, note);
        fileList.append(row);
        return {
          file,
          spec: created.files.find((f) => f.name === name),
          etags: new Map(),
          done: false,
          row,
          bar,
          note,
        };
      });
      state = { batchId: created.batchId, jobs, body };
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

/** Polls the ingest's verdict until it's final or the view goes away. */
async function watch(
  config: RuntimeConfig,
  brand: string,
  batchId: string,
  out: HTMLElement,
  onRejected: () => void,
) {
  const start = Date.now();
  while (out.isConnected && Date.now() - start < 600_000) {
    let status: BatchStatus | undefined;
    try {
      status = await get<BatchStatus>(config, `/brands/${brand}/shorts/${batchId}`);
      out.replaceChildren(statusView(config, brand, status));
      if (status.status === 'rejected') {
        onRejected();
        return;
      }
      if (status.status === 'ingested') return;
    } catch (e) {
      out.replaceChildren(el('p', `Couldn't check the batch: ${(e as Error).message}`, 'error'));
    }
    await sleep(3000);
  }
}

/**
 * What the ingest made of the batch. A rejected batch wrote nothing at all,
 * which is the one thing worth saying first.
 */
function statusView(config: RuntimeConfig, brand: string, status: BatchStatus) {
  const box = el('div', undefined, 'upload-status');
  if (status.status === 'uploading' || status.status === 'queued') {
    box.append(el('p', 'Recording the batch…'));
    return box;
  }
  if (status.status === 'rejected') {
    box.append(el('p', 'Rejected. Nothing was recorded:', 'error'));
    const list = el('ul', undefined, 'error');
    for (const e of status.errors ?? []) list.append(el('li', e));
    box.append(list, el('p', 'Fix the clips above and upload the batch again.', 'muted'));
    return box;
  }

  const items = status.items ?? [];
  box.append(
    el(
      'p',
      `Recorded ${items.length} item${items.length === 1 ? '' : 's'}${status.outlet ? ` for ${status.outlet}` : ''}.`,
      'ok',
    ),
  );
  const list = el('ul', undefined, 'batch-items');
  for (const item of items) {
    const li = el('li');
    li.append(
      el('span', item.title, 'file-name'),
      el('span', item.publishAt ? slotTime(item.publishAt) : 'No slot yet', 'muted'),
      // The slot is the thing most likely to want changing straight away.
      slotEditor(config, { brand, id: item.id, title: item.title, publishAt: item.publishAt }),
    );
    list.append(li);
  }
  box.append(list);
  box.append(
    el('p', 'Nothing is on YouTube yet: each clip uploads a few days before its slot.', 'muted'),
  );
  const actions = el('div', undefined, 'actions');
  const plan = link(`#/s/${brand}/slots`, 'Plan the slots');
  plan.className = 'button secondary';
  const schedule = link('#/schedule', 'See the schedule');
  schedule.className = 'button';
  actions.append(plan, schedule);
  box.append(actions);
  return box;
}
