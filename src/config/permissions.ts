/**
 * Role-based access control.
 *
 * The whole permission model lives in this one file so an auditor can read the
 * entire authorization surface in a single sitting. Routes reference named
 * permissions, never role names — so "can a VIEWER spend credits?" has exactly
 * one answer, in one place, rather than being re-decided at each call site.
 *
 * This is enforced server-side only. Templates may hide a button for tidiness,
 * but hiding a button is never the control.
 */

import { WorkspaceRole, PlatformRole } from '@prisma/client';

/**
 * Every distinct capability in the product.
 * Naming convention: `resource:action`.
 */
export const PERMISSIONS = [
  // Workspace
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'workspace:transfer_ownership',

  // Members
  'members:read',
  'members:invite',
  'members:update_role',
  'members:remove',

  // Google properties
  'properties:read',
  'properties:connect',
  'properties:disconnect',
  'properties:update',

  // URLs and jobs — `urls:write` and `jobs:create` are the credit-spending ones
  'urls:read',
  'urls:write',
  'urls:delete',
  'urls:export',
  'jobs:read',
  'jobs:create',
  'jobs:cancel',
  'jobs:retry',

  // Billing
  'billing:read',
  'billing:purchase',
  'billing:manage_subscription',

  // API keys
  'apikeys:read',
  'apikeys:create',
  'apikeys:revoke',

  // Audit and settings
  'audit:read',
  'settings:read',
  'settings:update',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The role → permission matrix.
 *
 * Read this table as the authorization spec:
 *  • VIEWER  cannot spend a single credit, cannot see billing, cannot export.
 *  • MEMBER  does the day-to-day work: add URLs, run jobs, spend credits.
 *  • ADMIN   configures the workspace and its Google connections, but cannot
 *            spend money, delete the workspace, or transfer ownership.
 *  • OWNER   everything, including the irreversible actions.
 *
 * Note the deliberate split: ADMIN can spend *credits* (operational) but not
 * *money* (contractual). Buying credits and managing subscriptions stay with the
 * OWNER, who is the billing contact of record.
 */
const VIEWER_PERMISSIONS: readonly Permission[] = [
  'workspace:read',
  'members:read',
  'properties:read',
  'urls:read',
  'jobs:read',
  'settings:read',
];

const MEMBER_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  'urls:write',
  'urls:delete',
  'urls:export',
  'jobs:create',
  'jobs:cancel',
  'jobs:retry',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  'workspace:update',
  'members:invite',
  'members:update_role',
  'members:remove',
  'properties:connect',
  'properties:disconnect',
  'properties:update',
  'apikeys:read',
  'apikeys:create',
  'apikeys:revoke',
  'audit:read',
  'settings:update',
  'billing:read', // can see the balance; cannot spend money
];

const OWNER_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  'workspace:delete',
  'workspace:transfer_ownership',
  'billing:purchase',
  'billing:manage_subscription',
];

export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, ReadonlySet<Permission>>> =
  Object.freeze({
    [WorkspaceRole.VIEWER]: new Set(VIEWER_PERMISSIONS),
    [WorkspaceRole.MEMBER]: new Set(MEMBER_PERMISSIONS),
    [WorkspaceRole.ADMIN]: new Set(ADMIN_PERMISSIONS),
    [WorkspaceRole.OWNER]: new Set(OWNER_PERMISSIONS),
  });

/** Ordering used for "can this role manage that role" checks. */
const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = Object.freeze({
  [WorkspaceRole.VIEWER]: 1,
  [WorkspaceRole.MEMBER]: 2,
  [WorkspaceRole.ADMIN]: 3,
  [WorkspaceRole.OWNER]: 4,
});

export function roleRank(role: WorkspaceRole): number {
  return ROLE_RANK[role];
}

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: WorkspaceRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/**
 * Privilege-escalation guard for member management.
 *
 * An ADMIN must not be able to promote themselves or a peer to OWNER, nor
 * remove an OWNER. Without this check, `members:update_role` alone would let any
 * ADMIN take over the workspace and its billing.
 */
export function canManageMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  desiredRole?: WorkspaceRole,
): { allowed: boolean; reason?: string } {
  if (!hasPermission(actorRole, 'members:update_role')) {
    return { allowed: false, reason: 'Your role cannot manage members.' };
  }

  // Only an OWNER may touch an OWNER.
  if (targetRole === WorkspaceRole.OWNER && actorRole !== WorkspaceRole.OWNER) {
    return { allowed: false, reason: 'Only the workspace owner can modify the owner.' };
  }

  // You may not act on someone at or above your own rank (except an OWNER, who
  // outranks everyone, acting on anyone).
  if (actorRole !== WorkspaceRole.OWNER && roleRank(targetRole) >= roleRank(actorRole)) {
    return {
      allowed: false,
      reason: 'You cannot modify a member whose role equals or exceeds your own.',
    };
  }

  // You may not grant a role above your own — this is the escalation block.
  if (desiredRole && roleRank(desiredRole) > roleRank(actorRole)) {
    return { allowed: false, reason: 'You cannot grant a role higher than your own.' };
  }

  // OWNER is transferred explicitly, never granted as a role edit, so that the
  // old owner is demoted in the same transaction and the single-owner database
  // index cannot be violated.
  if (desiredRole === WorkspaceRole.OWNER) {
    return {
      allowed: false,
      reason: 'Use "Transfer ownership" to change the workspace owner.',
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Platform administration
// ---------------------------------------------------------------------------

/**
 * Platform admin capabilities. Separate from workspace roles: a platform admin
 * is staff, not a tenant. SUPPORT_ADMIN is deliberately narrow so day-to-day
 * support work does not require the ability to change pricing.
 */
export const ADMIN_CAPABILITIES = [
  'admin:read', // view users, workspaces, jobs, payments
  'admin:credits_adjust', // grant or claw back credits (always audit-logged)
  'admin:refund', // refund a payment
  'admin:suspend', // suspend or reactivate a user or workspace
  'admin:pricing', // edit credit packages
  'admin:limits', // edit system limits and feature flags
  'admin:impersonate_read', // read-only view of a workspace for support
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

const PLATFORM_ROLE_CAPABILITIES: Readonly<
  Record<PlatformRole, ReadonlySet<AdminCapability>>
> = Object.freeze({
  [PlatformRole.USER]: new Set<AdminCapability>(),
  [PlatformRole.SUPPORT_ADMIN]: new Set<AdminCapability>([
    'admin:read',
    'admin:credits_adjust',
    'admin:impersonate_read',
  ]),
  [PlatformRole.SUPER_ADMIN]: new Set<AdminCapability>(ADMIN_CAPABILITIES),
});

export function hasAdminCapability(
  role: PlatformRole,
  capability: AdminCapability,
): boolean {
  return PLATFORM_ROLE_CAPABILITIES[role].has(capability);
}

export function isPlatformAdmin(role: PlatformRole): boolean {
  return role !== PlatformRole.USER;
}

// ---------------------------------------------------------------------------
// API key scopes
// ---------------------------------------------------------------------------

/**
 * Scopes available to API keys. Intentionally a subset of workspace
 * permissions: an API key can never manage members, billing or other keys.
 * That keeps a leaked key from being used to escalate or to lock the owner out.
 */
export const API_SCOPES = [
  'urls:read',
  'urls:write',
  'jobs:read',
  'jobs:write',
  'credits:read',
  'usage:read',
  'properties:read',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const DEFAULT_API_SCOPES: ApiScope[] = [
  'urls:read',
  'urls:write',
  'jobs:read',
  'jobs:write',
  'credits:read',
  'usage:read',
  'properties:read',
];

export function isValidApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Which scope a given API endpoint demands. Enforced in the API router. */
export const SCOPES_THAT_SPEND_CREDITS: readonly ApiScope[] = ['jobs:write'];
