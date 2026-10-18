import { describe, expect, it } from 'vitest';
import { describeGroups, planRoles } from '../src/commands/dashboard';

describe('planRoles', () => {
  it('adds per-show groups and swaps an existing role for the same show', () => {
    expect(planRoles(['viewer:cc'], { role: 'uploader', show: ['cc', 'dd'] })).toEqual({
      add: ['uploader:cc', 'uploader:dd'],
      remove: ['viewer:cc'],
    });
    expect(planRoles(['uploader:cc', 'viewer:dd'], { role: 'viewer', show: ['cc'] })).toEqual({
      add: ['viewer:cc'],
      remove: ['uploader:cc'],
    });
  });

  it('does nothing when the user already has the role', () => {
    expect(planRoles(['admin'], { role: 'admin' })).toEqual({ add: [], remove: [] });
  });

  it('removes one show, or everything', () => {
    const current = ['admin', 'viewer:cc', 'uploader:dd'];
    expect(planRoles(current, { role: 'none', show: ['dd'] })).toEqual({
      add: [],
      remove: ['uploader:dd'],
    });
    expect(planRoles(current, { role: 'none' })).toEqual({ add: [], remove: current });
  });

  it('refuses per-show roles without shows, admin with shows, and bad input', () => {
    expect(() => planRoles([], { role: 'uploader' })).toThrow(/--show/);
    expect(() => planRoles([], { role: 'viewer', show: [] })).toThrow(/--show/);
    expect(() => planRoles([], { role: 'admin', show: ['cc'] })).toThrow(/every show/);
    expect(() => planRoles([], { role: 'owner', show: ['cc'] })).toThrow(/Unknown role/);
    expect(() => planRoles([], { role: 'viewer', show: ['Bad Show'] })).toThrow(/slug/);
  });
});

describe('describeGroups', () => {
  it('summarises roles', () => {
    expect(describeGroups([])).toBe('no access');
    expect(describeGroups(['uploader:dd', 'viewer:cc', 'uploader:aa'])).toBe(
      'viewer: cc; uploader: aa, dd',
    );
    expect(describeGroups(['admin'])).toBe('admin');
  });
});
