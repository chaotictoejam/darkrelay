import { post, type BrandIconResponse, type BrandSummary } from './api';
import type { RuntimeConfig } from './auth';
import { brandIcon, el } from './ui';

/**
 * What the picker offers, and the one check worth making before sending
 * anything: the API checks the bytes again — that it is a readable PNG or
 * JPEG, square, and at least 128px — and its answer is what gets shown, so
 * the rules live in one place rather than two.
 */
const ACCEPT = 'image/png,image/jpeg';
const MAX_BYTES = 2 * 1024 ** 2;

const HINT = 'Square PNG or JPEG, at least 128px, up to 2 MB.';

function base64(bytes: Uint8Array): string {
  // btoa takes a string, and one argument per byte overflows the stack on a
  // file this size, so the bytes go in a chunk at a time.
  const CHUNK = 0x8000;
  let chars = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chars += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(chars);
}

export interface IconEditorOptions {
  /** Called once the new icon is stored, so the switcher can be redrawn. */
  onUpdated?: (icon: BrandIconResponse) => void;
}

/**
 * The brand's icon, as something an uploader can replace: the icon itself is
 * the picker. Shown only to people who may upload for the brand — the API
 * checks the same role, so the button is a convenience, not the protection.
 */
export function iconEditor(
  config: RuntimeConfig,
  brand: Partial<BrandSummary> & { show: string },
  options: IconEditorOptions = {},
): HTMLElement {
  const wrap = el('div', undefined, 'brand-icon-edit');
  const pick = el('label', undefined, 'icon-pick');
  pick.title = `Change the brand icon. ${HINT}`;
  const input = el('input', undefined, 'icon-input');
  input.type = 'file';
  input.accept = ACCEPT;
  const overlay = el('span', 'Change', 'icon-overlay');
  pick.append(brandIcon(config, brand, 36), overlay, input);

  const status = el('p', undefined, 'icon-status muted');
  status.hidden = true;
  const say = (message: string, bad = false) => {
    status.textContent = message;
    status.className = bad ? 'icon-status error' : 'icon-status muted';
    status.hidden = false;
  };

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void send(file);
  });

  async function send(file: File) {
    if (file.size > MAX_BYTES) return say(`${file.name} is over 2 MB. ${HINT}`, true);
    if (file.type && !ACCEPT.includes(file.type)) {
      return say(`${file.name} is not a PNG or JPEG. ${HINT}`, true);
    }
    input.disabled = true;
    say(`Uploading ${file.name}…`);
    try {
      const result = await post<BrandIconResponse>(config, `/brands/${brand.show}/icon`, {
        filename: file.name,
        data: base64(new Uint8Array(await file.arrayBuffer())),
      });
      // The key is content-addressed, so the new URL is new: nothing has to
      // be cache-busted, and the old icon stays valid wherever it is cached.
      const next = brandIcon(config, { ...brand, ...result }, 36);
      pick.replaceChildren(next, overlay, input);
      say('Icon updated.');
      options.onUpdated?.(result);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  }

  wrap.append(pick, status);
  return wrap;
}
