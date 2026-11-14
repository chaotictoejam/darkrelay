import { describe, expect, it } from 'vitest';
import {
  ACCEPT_BATCH,
  batchName,
  buildBatch,
  isImage,
  isVideo,
  titleFromName,
  type ClipInput,
} from '../src/shorts-plan';

/**
 * What the Shorts form sends. The manifest it builds has to be the same thing
 * a hand-written shorts.json is, so a clip with nothing of its own takes the
 * batch defaults rather than carrying empty strings to YouTube.
 */

const clip = (over: Partial<ClipInput> = {}): ClipInput => ({
  name: 'clip-01.mp4',
  title: 'The bus factor nobody admits to',
  description: '',
  tags: '',
  parentId: '',
  thumbnail: '',
  slot: '',
  ...over,
});

const defaults = { kind: 'short' as const, outlet: '', description: '', tags: '' };

describe('which files are which', () => {
  it('knows a clip from a thumbnail', () => {
    for (const name of ['a.mp4', 'a.MOV', 'a.m4v', 'a.webm']) expect(isVideo(name)).toBe(true);
    for (const name of ['a.jpg', 'a.JPEG', 'a.png']) expect(isImage(name)).toBe(true);
    for (const name of ['a.mp3', 'notes.txt', 'noext']) {
      expect(isVideo(name) || isImage(name)).toBe(false);
    }
    expect(ACCEPT_BATCH).toContain('.mp4');
    expect(ACCEPT_BATCH).toContain('.png');
  });
});

describe('names inside the batch', () => {
  it('rewrites what the API will not take, keeping the extension', () => {
    expect(batchName('Clip 01 (final).mp4')).toBe('Clip-01-final.mp4');
    // The extension is lowercased, so one clip cannot arrive as two names.
    expect(batchName('résumé cut.MP4')).toBe('resume-cut.mp4');
    expect(batchName('   .mp4')).toBe('clip.mp4');
    expect(batchName('a'.repeat(80) + '.mp4')).toBe('a'.repeat(40) + '.mp4');
  });

  it('keeps two files of the same name apart', () => {
    const taken = new Set<string>();
    expect(batchName('clip.mp4', taken)).toBe('clip.mp4');
    expect(batchName('clip.mp4', taken)).toBe('clip-2.mp4');
    expect(batchName('clip.mp4', taken)).toBe('clip-3.mp4');
  });

  it('guesses a readable title from the file name', () => {
    expect(titleFromName('bus_factor-part-one.mp4')).toBe('bus factor part one');
    expect(titleFromName('clip-01.mp4')).toBe('clip 01');
  });
});

describe('the manifest', () => {
  it('leaves empty fields out so the batch defaults apply', () => {
    const { body, errors } = buildBatch([clip()], {
      ...defaults,
      description: 'Full episode in the description.',
      tags: 'podcast, git',
    });
    expect(errors).toEqual([]);
    expect(body).toEqual({
      kind: 'short',
      defaults: { description: 'Full episode in the description.', tags: ['podcast', 'git'] },
      shorts: [{ file: 'clip-01.mp4', title: 'The bus factor nobody admits to' }],
    });
  });

  it('carries what a clip says for itself', () => {
    const { body, errors } = buildBatch(
      [
        clip({
          description: 'A standalone Short.',
          tags: ' git , rebase ',
          parentId: 'aaaaaaaaaaaaaaaa',
          thumbnail: 'clip-01.jpg',
          slot: '2026-12-01T12:00',
        }),
      ],
      defaults,
    );
    expect(errors).toEqual([]);
    expect(body.shorts[0]).toMatchObject({
      description: 'A standalone Short.',
      tags: ['git', 'rebase'],
      parentId: 'aaaaaaaaaaaaaaaa',
      thumbnail: 'clip-01.jpg',
    });
    // The slot carries the browser's own zone, as `--pub-date` does.
    expect(body.shorts[0]!.publishAt).toMatch(/^2026-12-01T12:00:00[+-]\d{2}:\d{2}$/);
  });

  it('sends no defaults block when nothing is shared', () => {
    const { body } = buildBatch([clip()], defaults);
    expect(body.defaults).toBe(undefined);
    expect(body.outlet).toBe(undefined);
  });

  it('names the outlet and the kind when they are chosen', () => {
    const { body } = buildBatch([clip()], { ...defaults, kind: 'video', outlet: 'second' });
    expect(body).toMatchObject({ kind: 'video', outlet: 'second' });
  });

  it('collects every problem at once rather than the first', () => {
    const { errors } = buildBatch(
      [
        clip({ title: '' }),
        clip({ name: 'clip-02.mp4', title: 'x'.repeat(101) }),
        clip({ name: 'clip-03.mp4', title: 'A <b> title' }),
        clip({ name: 'clip-04.mp4', slot: '2026-02-30T12:00' }),
      ],
      defaults,
    );
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('add a title');
    expect(errors[1]).toContain('100 characters');
    expect(errors[2]).toContain('< or >');
    expect(errors[3]).toContain('not a real date');
  });

  it('asks for at least one clip', () => {
    expect(buildBatch([], defaults).errors).toEqual([expect.stringContaining('at least one')]);
  });

  it('holds descriptions to what YouTube accepts, shared or not', () => {
    const long = 'é'.repeat(2600);
    expect(buildBatch([clip({ description: long })], defaults).errors).toEqual([
      expect.stringContaining('5000 bytes'),
    ]);
    expect(buildBatch([clip()], { ...defaults, description: long }).errors).toEqual([
      expect.stringContaining('5000 bytes'),
    ]);
  });
});
