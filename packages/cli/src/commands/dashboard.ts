import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  GroupExistsException,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ADMIN_GROUP, SHOW_ROLES, SLUG, layout, showGroup, type ShowRole } from '@darkrelay/core';
import { Bucket, resolveDeployment, stackOutputs, type GlobalOptions } from '../context';

const region = 'us-east-1';
export const ROLES = ['admin', ...SHOW_ROLES, 'none'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleFlags {
  role: string;
  show?: string[];
}

/**
 * Group changes for a role. `admin` is deployment-wide; `viewer` and
 * `uploader` apply to the listed shows and replace any other role the user
 * had for them; `none` removes the listed shows, or with no shows, every role.
 */
export function planRoles(current: string[], flags: RoleFlags) {
  const role = flags.role as Role;
  const shows = [...new Set(flags.show ?? [])];
  if (!ROLES.includes(role)) throw new Error(`Unknown role "${flags.role}" (${ROLES.join(', ')})`);
  const bad = shows.filter((s) => !SLUG.test(s));
  if (bad.length) throw new Error(`Not a show slug: ${bad.join(', ')}`);
  if (role === 'admin' && shows.length)
    throw new Error('admin covers every show; leave out --show');
  if ((role === 'viewer' || role === 'uploader') && !shows.length)
    throw new Error(`${role} is per show: add --show <slug> (one or more)`);

  const has = new Set(current);
  const want = new Set<string>();
  const drop = new Set<string>();
  if (role === 'admin') want.add(ADMIN_GROUP);
  else if (role === 'none' && !shows.length) current.forEach((g) => drop.add(g));
  for (const show of shows) {
    for (const r of SHOW_ROLES) {
      if (r === role) want.add(showGroup(r, show));
      else drop.add(showGroup(r, show));
    }
  }
  return {
    add: [...want].filter((g) => !has.has(g)),
    remove: [...drop].filter((g) => has.has(g)),
  };
}

/** "admin", "uploader: cc, dd" ... for printing. */
export function describeGroups(groups: string[]): string {
  if (!groups.length) return 'no access';
  const parts: string[] = groups.includes(ADMIN_GROUP) ? ['admin'] : [];
  for (const r of SHOW_ROLES) {
    const shows = groups.filter((g) => g.startsWith(`${r}:`)).map((g) => g.slice(r.length + 1));
    if (shows.length) parts.push(`${r}: ${shows.sort().join(', ')}`);
  }
  return parts.join('; ') || 'no access';
}

async function context(global: GlobalOptions) {
  const out = await stackOutputs(global, 'Dashboard');
  if (!out['UserPoolId']) throw new Error(`${global.stackPrefix}Dashboard is not deployed`);
  return { out, poolId: out['UserPoolId'], cognito: new CognitoIdentityProviderClient({ region }) };
}

async function groupsOf(cognito: CognitoIdentityProviderClient, poolId: string, user: string) {
  const groups: string[] = [];
  let token: string | undefined;
  do {
    const r = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: poolId, Username: user, NextToken: token }),
    );
    for (const g of r.Groups ?? []) groups.push(g.GroupName!);
    token = r.NextToken;
  } while (token);
  return groups;
}

async function applyRoles(global: GlobalOptions, email: string, flags: RoleFlags) {
  const { poolId, cognito } = await context(global);
  const current = await groupsOf(cognito, poolId, email);
  const { add, remove } = planRoles(current, flags);

  const shows = [...new Set(flags.show ?? [])];
  if (shows.length && flags.role !== 'none') {
    const { bucket } = await resolveDeployment(global);
    const b = new Bucket(bucket);
    const missing = [];
    for (const s of shows) if (!(await b.exists(layout.showConfig(s)))) missing.push(s);
    if (missing.length) throw new Error(`No such show: ${missing.join(', ')}`);
  }

  for (const group of add) {
    const [role, show] = group.split(':') as [ShowRole, string | undefined];
    if (show) {
      await cognito
        .send(
          new CreateGroupCommand({
            UserPoolId: poolId,
            GroupName: group,
            Description: `${role === 'uploader' ? 'Analytics and uploads' : 'Analytics'} for ${show}`,
          }),
        )
        .catch((e: unknown) => {
          if (!(e instanceof GroupExistsException)) throw e;
        });
    }
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: group }),
    );
  }
  for (const group of remove) {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: poolId,
        Username: email,
        GroupName: group,
      }),
    );
  }
  const now = [...current.filter((g) => !remove.includes(g)), ...add];
  console.log(`${email}: ${describeGroups(now)}`);
  if (add.length || remove.length)
    console.log('Takes effect at their next sign-in (or within the hour).');
}

export async function addDashboardUser(email: string, flags: RoleFlags, global: GlobalOptions) {
  // Check the role before creating anyone, so a typo doesn't leave a user with no access.
  planRoles([], flags);
  if (flags.role === 'none') throw new Error('Give the new user a role: admin, viewer or uploader');
  const { out, poolId, cognito } = await context(global);
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }),
  );
  await applyRoles(global, email, flags);
  console.log(
    `Invited ${email}. Cognito emails a temporary password; sign in at ${out['DashboardUrl']}`,
  );
}

export async function setDashboardRole(email: string, flags: RoleFlags, global: GlobalOptions) {
  await applyRoles(global, email, flags);
}

export async function listDashboardUsers(global: GlobalOptions) {
  const { poolId, cognito } = await context(global);
  let token: string | undefined;
  do {
    const r = await cognito.send(
      new ListUsersCommand({ UserPoolId: poolId, PaginationToken: token }),
    );
    for (const u of r.Users ?? []) {
      const email = u.Attributes?.find((a) => a.Name === 'email')?.Value ?? u.Username!;
      const groups = await groupsOf(cognito, poolId, u.Username!);
      console.log(
        `${email}  ${describeGroups(groups)}${u.Enabled === false ? '  (disabled)' : ''}`,
      );
    }
    token = r.PaginationToken;
  } while (token);
}

export async function removeDashboardUser(email: string, global: GlobalOptions) {
  const { poolId, cognito } = await context(global);
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: email }));
  console.log(`Removed ${email} from the dashboard`);
}
