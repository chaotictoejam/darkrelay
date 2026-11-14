import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RescheduleResponse } from '../src/api';
import type { RuntimeConfig } from '../src/auth';
import { find, installDom, text, type Node } from './dom';

/**
 * Moving a slot from the dashboard. What matters here is what the person is
 * told: a clip that has not been uploaded yet goes up before its slot, while
 * one already sitting on YouTube is moved there — and neither is a re-upload.
 */

const stub = vi.hoisted(() => ({
  posts: [] as { path: string; body: unknown }[],
  reply: undefined as RescheduleResponse | undefined,
  fail: undefined as string | undefined,
}));

vi.mock('../src/api', () => ({
  async get() {
    throw new Error('not used');
  },
  async post(_config: unknown, path: string, body: unknown) {
    stub.posts.push({ path, body });
    if (stub.fail) throw new Error(stub.fail);
    return stub.reply;
  },
}));

installDom();
const { slotEditor } = await import('../src/reschedule');

const config = { apiUrl: 'https://api.example' } as RuntimeConfig;

const reply = (over: Partial<RescheduleResponse> = {}): RescheduleResponse => ({
  id: 'clip-1',
  title: 'The bus factor',
  publishAt: '2026-12-01T17:00:00Z',
  outlet: 'youtube',
  state: 'planned',
  syncing: false,
  warnings: [],
  ...over,
});

const button = (node: Node, label: string) =>
  find(node, (n: Node) => n.tag === 'button' && text(n) === label)[0];
const input = (node: Node) => find(node, (n: Node) => n.tag === 'input')[0];
const click = async (node: Node, label: string) => {
  button(node, label).handlers.click();
  // The handlers are not awaited, so let the mocked POST settle.
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  stub.posts = [];
  stub.reply = reply();
  stub.fail = undefined;
});

describe('the control', () => {
  it('offers a slot where there is none, and a move where there is one', () => {
    expect(text(slotEditor(config, { brand: 'cc', id: 'clip-1', title: 'A' }))).toContain(
      'Give it a slot',
    );
    const withSlot = slotEditor(config, {
      brand: 'cc',
      id: 'clip-1',
      title: 'A',
      publishAt: '2026-12-01T17:00:00Z',
    });
    expect(text(withSlot)).toContain('Reschedule');
  });

  it('opens with the current slot prefilled', () => {
    const editor = slotEditor(config, {
      brand: 'cc',
      id: 'clip-1',
      title: 'A',
      publishAt: '2026-12-01T17:00:00Z',
    });
    button(editor, 'Reschedule').handlers.click();
    expect(input(editor).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('saving', () => {
  const open = (over = {}) => {
    const editor = slotEditor(config, {
      brand: 'cc',
      id: 'clip-1',
      title: 'A',
      publishAt: '2026-12-01T17:00:00Z',
      ...over,
    });
    button(editor, 'Reschedule').handlers.click();
    return editor;
  };

  it('sends the time with its zone and says what happens next', async () => {
    const editor = open();
    input(editor).value = '2026-12-05T18:30';
    await click(editor, 'Save');
    expect(stub.posts).toHaveLength(1);
    expect(stub.posts[0]!.path).toBe('/schedule/cc/content/clip-1');
    expect((stub.posts[0]!.body as { at: string }).at).toMatch(
      /^2026-12-05T18:30:00[+-]\d{2}:\d{2}$/,
    );
    expect(text(editor)).toContain('It uploads a few days before that');
  });

  it('refuses an empty time without calling the API', async () => {
    const editor = open();
    input(editor).value = '';
    await click(editor, 'Save');
    expect(stub.posts).toEqual([]);
    expect(text(editor)).toContain('Choose a date and time');
  });

  it('releases one now', async () => {
    const editor = open();
    stub.reply = reply({ publishAt: '2026-11-13T12:00:00Z' });
    await click(editor, 'Release now');
    expect(stub.posts[0]!.body).toEqual({ at: 'now' });
  });

  /** The case the user asked for: it is already on YouTube. */
  it('says the platform is being told when the video is already uploaded', async () => {
    const editor = open({ state: 'scheduled', externalId: 'yt-1' });
    stub.reply = reply({ state: 'scheduled', externalId: 'yt-1', syncing: true });
    input(editor).value = '2026-12-05T18:30';
    await click(editor, 'Save');
    expect(text(editor)).toContain('YouTube is being told now');
    expect(text(editor)).not.toContain('uploads a few days');
  });

  it('passes the sweep and the already-out warnings through', async () => {
    const editor = open({ state: 'scheduled', externalId: 'yt-1' });
    stub.reply = reply({
      state: 'published',
      externalId: 'yt-1',
      warnings: ['This one is already public on YouTube.'],
    });
    input(editor).value = '2026-12-05T18:30';
    await click(editor, 'Save');
    expect(text(editor)).toContain('Already out');
    expect(text(editor)).toContain('already public on YouTube');
  });

  it('shows what the API refused', async () => {
    const editor = open();
    stub.fail = 'No content "clip-1" for cc';
    input(editor).value = '2026-12-05T18:30';
    await click(editor, 'Save');
    expect(text(editor)).toContain('No content');
  });
});
