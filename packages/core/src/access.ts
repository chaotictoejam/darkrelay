import { SLUG } from './model';

/**
 * Dashboard permissions are Cognito user pool groups. `admin` covers every
 * show; the others name one show each, e.g. `uploader:my-show`. A signed-in
 * user in no group can see nothing.
 */
export const ADMIN_GROUP = 'admin';
export const SHOW_ROLES = ['viewer', 'uploader'] as const;
export type ShowRole = (typeof SHOW_ROLES)[number];

export function showGroup(role: ShowRole, show: string): string {
  return `${role}:${show}`;
}

export interface Access {
  admin: boolean;
  /** Shows the user can see analytics for (uploaders can too). */
  view: Set<string>;
  upload: Set<string>;
}

export function accessFromGroups(groups: readonly string[]): Access {
  const access: Access = { admin: false, view: new Set(), upload: new Set() };
  for (const g of groups) {
    if (g === ADMIN_GROUP) {
      access.admin = true;
      continue;
    }
    const [role, show] = g.split(':', 2) as [string, string | undefined];
    if (!show || !SLUG.test(show)) continue;
    if (role === 'viewer') access.view.add(show);
    if (role === 'uploader') {
      access.view.add(show);
      access.upload.add(show);
    }
  }
  return access;
}

export const canView = (a: Access, show: string) => a.admin || a.view.has(show);
export const canUpload = (a: Access, show: string) => a.admin || a.upload.has(show);

/**
 * The `cognito:groups` claim as API Gateway hands it over. HTTP API JWT
 * authorizers flatten arrays to a string like "[admin uploader:cc]"; group
 * names can't contain spaces, so splitting on them is safe.
 */
export function groupsClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}
