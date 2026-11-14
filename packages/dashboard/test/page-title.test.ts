import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/auth';
import { createElement, find, installDom, text, type Node } from './dom';

const responses = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  async get(_config: unknown, path: string) {
    const key = path.split('?')[0]!;
    if (!responses.has(key)) throw new Error(`No response for ${path}`);
    return responses.get(key);
  },
}));

vi.mock('../src/auth', () => ({
  completeSignIn: async () => {},
  currentToken: () => undefined,
  signIn: () => {},
  signOut: () => {},
}));

const config = { apiUrl: 'https://api.example' } as RuntimeConfig;
let app: Node;
let render: typeof import('../src/main').render;

beforeEach(async () => {
  vi.resetModules();
  installDom();
  app = createElement('main');
  app.querySelector = (tag: string) => find(app, (node) => node.tag === tag)[0] ?? null;
  vi.stubGlobal('document', {
    ...document,
    title: 'DarkRelay',
    getElementById: (id: string) => (id === 'app' ? app : null),
  });
  vi.stubGlobal('location', {
    hash: '',
    replace: vi.fn((hash: string) => {
      location.hash = hash;
    }),
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => config })),
  );
  responses.clear();
  responses.set('/shows', { shows: [] });
  responses.set('/me', { admin: true, upload: [], view: [] });
  responses.set('/schedule', {
    now: '2026-11-14T12:00:00Z',
    brands: [],
    upcoming: [],
    unscheduled: [],
    plans: [],
  });
  ({ render } = await import('../src/main'));
});

afterEach(() => vi.unstubAllGlobals());

describe('page titles', () => {
  it.each([
    ['#/schedule', 'Schedule'],
    ['#/upload', 'Upload episode'],
    ['#/shorts', 'Upload Shorts'],
  ])('names the rendered page at %s', async (hash, heading) => {
    location.hash = hash;
    await render(config);
    expect(text(app)).toContain(heading);
    expect(document.title).toBe(`${heading} · DarkRelay`);
  });

  it('restores the default title on the root route', async () => {
    document.title = 'Schedule · DarkRelay';
    await render(config);
    expect(text(app)).toContain('Brands');
    expect(document.title).toBe('DarkRelay');
  });

  it('uses the episode title rather than its route id', async () => {
    location.hash = '#/s/cc/e/episode-id';
    responses.set('/brands/cc/episodes/episode-id', {
      from: '2026-11-01',
      to: '2026-11-03',
      daily: [],
      totals: { downloads: 0, countries: {}, devices: {} },
      episode: {
        title: 'A useful episode title',
        pubDate: '2026-11-01T12:00:00Z',
        downloadsTotal: 0,
        downloads7: 0,
        downloads30: 0,
        downloads90: 0,
      },
    });
    await render(config);
    expect(text(app)).toContain('A useful episode title');
    expect(document.title).toBe('A useful episode title · DarkRelay');
  });

  it('restores the default title if a route fails', async () => {
    document.title = 'Schedule · DarkRelay';
    location.hash = '#/schedule';
    responses.delete('/schedule');
    await render(config);
    expect(text(app)).toContain('No response for /schedule');
    expect(document.title).toBe('DarkRelay');
  });

  it('does not reuse the previous heading when the brand list redirects', async () => {
    app.append(createElement('h1'));
    app.children[0].textContent = 'Previous page';
    document.title = 'Previous page · DarkRelay';
    location.hash = '#/unknown';
    responses.set('/shows', { shows: [{ show: 'cc', title: 'Chaotic Commits' }] });
    await render(config);
    expect(location.hash).toBe('#/s/cc');
    expect(document.title).toBe('DarkRelay');
  });
});
