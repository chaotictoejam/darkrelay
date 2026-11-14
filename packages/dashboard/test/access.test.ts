import { describe, expect, it } from 'vitest';
import { canManage, type MeResponse } from '../src/api';

const roles = (over: Partial<MeResponse> = {}): MeResponse => ({
  admin: false,
  view: ['cc'],
  upload: [{ show: 'cc', title: 'Chaotic Commits' }],
  ...over,
});

describe('canManage', () => {
  it('follows `manage`, which includes a brand with no feed to upload to', () => {
    const me = roles({ manage: ['cc', 'yt-only'] });
    expect(canManage(me, 'cc')).toBe(true);
    expect(canManage(me, 'yt-only')).toBe(true);
    expect(canManage(me, 'someone-elses')).toBe(false);
  });

  it('falls back to the shows an episode can be uploaded to, for an older API', () => {
    expect(canManage(roles(), 'cc')).toBe(true);
    expect(canManage(roles(), 'yt-only')).toBe(false);
  });

  it('offers nothing to someone who may only look', () => {
    const me = roles({ upload: [], manage: [] });
    expect(canManage(me, 'cc')).toBe(false);
  });
});
