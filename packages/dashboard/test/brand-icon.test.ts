import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/auth';
import { find, installDom, text, type Node } from './dom';

/**
 * The icon picker, actually run: a file goes in, base64 comes out of the
 * other side, and what the person is told is read back off the page.
 */

const stub = vi.hoisted(() => ({
  posted: [] as { path: string; body: unknown }[],
  reply: undefined as unknown,
  fail: undefined as string | undefined,
}));

vi.mock('../src/api', () => ({
  async post(_config: unknown, path: string, body: unknown) {
    stub.posted.push({ path, body });
    if (stub.fail) throw new Error(stub.fail);
    return stub.reply;
  },
}));

installDom();
const { iconEditor } = await import('../src/brand-icon');

const config = { apiUrl: 'https://api.example', mediaUrl: 'https://cdn.example' } as RuntimeConfig;
const brand = { show: 'cc', title: 'Chaotic Commits', iconKey: 'cc/icon-aaaaaaaa.png' };

/** A file as the picker gets one, with only the parts the editor touches. */
function file(name: string, bytes: Uint8Array, type = 'image/png') {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  } as unknown as File;
}

const input = (editor: Node): Node => find(editor, (n) => n.className === 'icon-input')[0];
const images = (editor: Node): Node[] => find(editor, (n) => n.tag === 'img');

/** Picks a file, and waits for the upload the change handler starts. */
async function pick(editor: Node, picked: File) {
  input(editor).files = [picked];
  input(editor).handlers.change();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  stub.posted = [];
  stub.fail = undefined;
  stub.reply = { brand: 'cc', iconKey: 'cc/icon-bbbbbbbb.png', iconUrl: undefined };
});

describe('iconEditor', () => {
  it('shows the brand icon as the picker, with the rules for it', () => {
    const editor = iconEditor(config, brand) as unknown as Node;
    expect(images(editor)[0].src).toBe('https://cdn.example/cc/icon-aaaaaaaa.png');
    expect(find(editor, (n) => n.className === 'icon-pick')[0].title).toMatch(
      /Square PNG or JPEG, at least 128px, up to 2 MB/,
    );
    expect(input(editor).accept).toBe('image/png,image/jpeg');
    expect(stub.posted).toEqual([]);
  });

  it('sends the bytes as base64 and shows the icon it gets back', async () => {
    const editor = iconEditor(config, brand) as unknown as Node;
    const updated: unknown[] = [];
    const withCallback = iconEditor(config, brand, {
      onUpdated: (icon) => updated.push(icon),
    }) as unknown as Node;

    await pick(editor, file('new.png', new Uint8Array([1, 2, 3])));
    expect(stub.posted).toEqual([
      { path: '/brands/cc/icon', body: { filename: 'new.png', data: 'AQID' } },
    ]);
    expect(images(editor)[0].src).toBe('https://cdn.example/cc/icon-bbbbbbbb.png');
    expect(text(editor)).toContain('Icon updated.');

    await pick(withCallback, file('new.png', new Uint8Array([1, 2, 3])));
    expect(updated).toEqual([{ brand: 'cc', iconKey: 'cc/icon-bbbbbbbb.png', iconUrl: undefined }]);
  });

  it('prefers the URL the API sends over one built from the key', async () => {
    stub.reply = { brand: 'cc', iconKey: 'cc/icon-cccccccc.png', iconUrl: 'https://other/i.png' };
    const editor = iconEditor(config, brand) as unknown as Node;
    await pick(editor, file('new.png', new Uint8Array([9])));
    expect(images(editor)[0].src).toBe('https://other/i.png');
  });

  it('turns down a file that is plainly wrong without calling the API', async () => {
    const editor = iconEditor(config, brand) as unknown as Node;
    await pick(editor, file('icon.gif', new Uint8Array([1]), 'image/gif'));
    expect(stub.posted).toEqual([]);
    expect(text(editor)).toContain('icon.gif is not a PNG or JPEG');

    await pick(editor, file('huge.png', new Uint8Array(3 * 1024 ** 2)));
    expect(stub.posted).toEqual([]);
    expect(text(editor)).toContain('huge.png is over 2 MB');
  });

  it("shows the API's own refusal, and keeps the icon that is there", async () => {
    stub.fail = 'banner.png is 1280x720; a brand icon must be square';
    const editor = iconEditor(config, brand) as unknown as Node;
    await pick(editor, file('banner.png', new Uint8Array([1])));
    expect(text(editor)).toContain('a brand icon must be square');
    expect(images(editor)[0].src).toBe('https://cdn.example/cc/icon-aaaaaaaa.png');
    // The picker is usable again, so a second try needs no reload.
    expect(input(editor).disabled).toBe(false);
  });
});
