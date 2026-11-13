import { describe, expect, it } from 'vitest';
import type { ScheduleEntry, SlotScore, SlotScoresResponse } from '../src/api';
import { byDay, dayLabel, heatGrid, heatLevel, stateNote } from '../src/schedule';

const slot = (over: Partial<SlotScore> = {}): SlotScore => ({
  day: 6,
  hour: 18,
  key: '6-18',
  score: 1.5,
  samples: 4,
  prior: 1,
  basis: 'history',
  ...over,
});

function scores(slots: SlotScore[]): SlotScoresResponse {
  const all: SlotScore[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const given = slots.find((s) => s.day === day && s.hour === hour);
      all.push(
        given ?? {
          day,
          hour,
          key: `${day}-${hour}`,
          score: 0.5,
          samples: 0,
          prior: 0.5,
          basis: 'prior',
        },
      );
    }
  }
  return { zone: 'America/New_York', samples: slots.length, slots: all };
}

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  brand: 'cc',
  brandTitle: 'Chaotic Commits',
  id: 'clip-1',
  title: 'A Short',
  kind: 'short',
  ...over,
});

describe('heatLevel', () => {
  it('leaves a slot with no history unshaded, which is information', () => {
    expect(heatLevel(slot({ samples: 0 }), 2)).toBeNull();
  });

  it('shades across five steps, with the best slot at the top', () => {
    expect(heatLevel(slot({ score: 2 }), 2)).toBe(4);
    expect(heatLevel(slot({ score: 0.1 }), 2)).toBe(0);
    // One score in the middle of each fifth of the range.
    const levels = [0.2, 0.6, 1.0, 1.4, 1.8].map((score) => heatLevel(slot({ score }), 2));
    expect(levels).toEqual([0, 1, 2, 3, 4]);
    // Anything at or above the best slot stays at the top step.
    expect(heatLevel(slot({ score: 2.5 }), 2)).toBe(4);
  });

  it('copes with a week where every score is zero', () => {
    expect(heatLevel(slot({ score: 0 }), 0)).toBe(0);
  });
});

describe('heatGrid', () => {
  it('returns the whole week', () => {
    expect(heatGrid(scores([]))).toHaveLength(168);
  });

  it('explains a tested slot with the numbers behind it', () => {
    const grid = heatGrid(
      scores([slot({ score: 1.74, samples: 4, views: 3000, viewRatio: 0.62, subsPerMille: 2.5 })]),
    );
    const cell = grid.find((c) => c.key === '6-18')!;
    expect(cell.label).toBe('Sat 18:00');
    expect(cell.title).toBe(
      'Sat 18:00 — 1.74x a typical slot, 4 videos, 3K views in 72h, 62% watched, 2.5 subs per 1k views',
    );
    expect(cell.level).toBe(4);
  });

  it('says plainly when a slot has never been tried', () => {
    const cell = heatGrid(scores([]))!.find((c) => c.key === '3-9')!;
    expect(cell.title).toBe('Wed 09:00 — never tried, prior 0.50');
    expect(cell.level).toBeNull();
  });

  it('leaves out a signal the data does not have', () => {
    const cell = heatGrid(scores([slot({ views: 100, viewRatio: undefined })])).find(
      (c) => c.key === '6-18',
    )!;
    expect(cell.title).not.toMatch(/watched/);
    expect(cell.title).toMatch(/100 views in 72h/);
  });

  it('does not claim a subscriber rate of zero is a finding', () => {
    const cell = heatGrid(scores([slot({ subsPerMille: 0 })])).find((c) => c.key === '6-18')!;
    expect(cell.title).not.toMatch(/subs per/);
  });
});

describe('byDay', () => {
  const now = new Date('2026-11-12T15:00:00Z');

  it('groups by day and orders each day by time', () => {
    const groups = byDay(
      [
        entry({ id: 'later', publishAt: '2026-11-20T23:00:00Z' }),
        entry({ id: 'early', publishAt: '2026-11-20T15:00:00Z' }),
        entry({ id: 'other-day', publishAt: '2026-11-21T15:00:00Z' }),
      ],
      now,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['early', 'later']);
    expect(groups[1]!.entries.map((e) => e.id)).toEqual(['other-day']);
    // Days themselves come in order.
    expect(groups[0]!.key < groups[1]!.key).toBe(true);
  });

  it('skips anything without a slot rather than inventing a day for it', () => {
    expect(byDay([entry({ publishAt: undefined })], now)).toEqual([]);
  });
});

describe('dayLabel', () => {
  const now = new Date('2026-11-12T15:00:00Z');

  it('says what a person would say about the next few days', () => {
    expect(dayLabel(now.toISOString(), now)).toBe('Today');
    expect(dayLabel('2026-11-13T15:00:00Z', now)).toBe('Tomorrow');
    expect(dayLabel('2026-11-11T15:00:00Z', now)).toBe('Yesterday');
  });

  it('names the day for anything further out', () => {
    expect(dayLabel('2026-11-21T15:00:00Z', now)).toMatch(/Nov 21/);
  });
});

describe('stateNote', () => {
  it('says where each item stands without jargon', () => {
    expect(stateNote(entry({ state: 'published' }))).toBe('live');
    expect(stateNote(entry({ state: 'scheduled' }))).toBe('uploaded, waiting for its time');
    expect(stateNote(entry({ state: 'uploading' }))).toBe('uploading now');
    expect(stateNote(entry({ state: 'planned' }))).toBe('not uploaded yet');
    expect(stateNote(entry())).toBe('not uploaded yet');
  });

  it('carries the reason a failure failed', () => {
    expect(stateNote(entry({ state: 'failed', error: 'quotaExceeded' }))).toBe(
      'failed: quotaExceeded',
    );
    expect(stateNote(entry({ state: 'failed' }))).toBe('failed: unknown error');
  });
});
