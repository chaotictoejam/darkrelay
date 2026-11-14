import { post, type RescheduleResponse } from './api';
import type { RuntimeConfig } from './auth';
import { slotTime } from './format';
import { el } from './ui';
import { isoToLocal, localToIso } from './upload-plan';

/**
 * Moving one item's slot from the dashboard. A video DarkRelay has already
 * uploaded is included on purpose: YouTube is holding it for a release time,
 * and that time is a thing you change your mind about. Saving rewrites the
 * content record and the worker moves the release on the platform; nothing
 * about it is a re-upload.
 */

export interface SlotTarget {
  brand: string;
  id: string;
  title: string;
  publishAt?: string;
  /** Where it stands on its outlet: planned, scheduled, published, failed. */
  state?: string;
  externalId?: string;
}

/** What saving a new time means for this item, in one line. */
function outcome(result: RescheduleResponse): string {
  const when = slotTime(result.publishAt);
  if (result.state === 'published') return `Already out; its slot now reads ${when}.`;
  if (result.externalId) {
    return result.syncing
      ? `Moved to ${when}. YouTube is being told now.`
      : `Moved to ${when}. YouTube follows at the next hourly pass.`;
  }
  return `Scheduled for ${when}. It uploads a few days before that.`;
}

/**
 * A button that opens a time field for one item. `onSaved` is called with the
 * API's answer, so a page that lists slots can redraw the row it changed.
 */
export function slotEditor(
  config: RuntimeConfig,
  target: SlotTarget,
  onSaved?: (result: RescheduleResponse) => void,
): HTMLElement {
  const wrap = el('div', undefined, 'slot-editor');
  const open = el('button', target.publishAt ? 'Reschedule' : 'Give it a slot', 'link-button');
  open.type = 'button';

  const panel = el('div', undefined, 'slot-panel');
  panel.hidden = true;
  const when = el('input');
  when.type = 'datetime-local';
  if (target.publishAt) when.value = isoToLocal(target.publishAt);
  const save = el('button', 'Save', 'primary small');
  save.type = 'button';
  const release = el('button', 'Release now', 'secondary small');
  release.type = 'button';
  const cancel = el('button', 'Cancel', 'link-button');
  cancel.type = 'button';
  const note = el('p', undefined, 'muted');
  note.hidden = true;

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const row = el('div', undefined, 'slot-row');
  row.append(when, save, release, cancel);
  panel.append(row, el('p', `Times are in your zone: ${zone}`, 'field-hint'), note);

  const show = (text: string, cls: 'muted' | 'ok' | 'error') => {
    note.className = cls;
    note.textContent = text;
    note.hidden = false;
  };

  const send = async (at: string) => {
    for (const b of [save, release]) b.disabled = true;
    show('Saving…', 'muted');
    try {
      const result = await post<RescheduleResponse>(
        config,
        `/schedule/${target.brand}/content/${target.id}`,
        { at },
      );
      show([outcome(result), ...result.warnings].join(' '), 'ok');
      when.value = isoToLocal(result.publishAt);
      onSaved?.(result);
    } catch (e) {
      show((e as Error).message, 'error');
    } finally {
      for (const b of [save, release]) b.disabled = false;
    }
  };

  open.addEventListener('click', () => {
    panel.hidden = false;
    open.hidden = true;
    when.focus();
  });
  cancel.addEventListener('click', () => {
    panel.hidden = true;
    open.hidden = false;
    note.hidden = true;
  });
  save.addEventListener('click', () => {
    const at = localToIso(when.value);
    if (!at) return show('Choose a date and time.', 'error');
    void send(at);
  });
  release.addEventListener('click', () => void send('now'));

  wrap.append(open, panel);
  return wrap;
}
