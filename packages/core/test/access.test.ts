import { describe, expect, it } from 'vitest';
import { accessFromGroups, canUpload, canView, groupsClaim, showGroup } from '../src/access';

describe('accessFromGroups', () => {
  it('gives no access without a group', () => {
    const a = accessFromGroups([]);
    expect(canView(a, 'cc')).toBe(false);
    expect(canUpload(a, 'cc')).toBe(false);
  });

  it('scopes viewers and uploaders to their shows', () => {
    const a = accessFromGroups([showGroup('viewer', 'cc'), showGroup('uploader', 'dd')]);
    expect(canView(a, 'cc')).toBe(true);
    expect(canUpload(a, 'cc')).toBe(false);
    expect(canView(a, 'dd')).toBe(true);
    expect(canUpload(a, 'dd')).toBe(true);
    expect(canView(a, 'ee')).toBe(false);
  });

  it('lets admins do everything on every show', () => {
    const a = accessFromGroups(['admin']);
    expect(canView(a, 'anything')).toBe(true);
    expect(canUpload(a, 'anything')).toBe(true);
  });

  it('ignores unknown roles, bare roles and bad slugs', () => {
    const a = accessFromGroups(['viewer', 'uploader', 'owner:cc', 'uploader:BAD!', 'Admin']);
    expect(a).toEqual({ admin: false, view: new Set(), upload: new Set() });
  });
});

describe('groupsClaim', () => {
  it('reads arrays and the flattened string API Gateway passes on', () => {
    expect(groupsClaim(['admin', 'viewer:cc'])).toEqual(['admin', 'viewer:cc']);
    expect(groupsClaim('[admin viewer:cc]')).toEqual(['admin', 'viewer:cc']);
    expect(groupsClaim('[uploader:cc]')).toEqual(['uploader:cc']);
    expect(groupsClaim(undefined)).toEqual([]);
    expect(groupsClaim('')).toEqual([]);
  });
});
