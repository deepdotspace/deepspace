/**
 * Standard DeepSpace role constants.
 *
 * Every DeepSpace app uses the same three roles.
 * Apps can import these instead of defining them locally.
 */

export const ROLES = {
  VIEWER: 'viewer',
  MEMBER: 'member',
  ADMIN: 'admin',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

/**
 * Whether a role may write app content: member and admin can, viewer is
 * read-only. The one chokepoint for every client-side write gate — an app
 * that defines custom write-capable roles extends this predicate once. The
 * server always re-checks writes against the schema's permission table; this
 * only controls what the UI offers.
 */
export function isWriterRole(role: unknown): role is Exclude<Role, typeof ROLES.VIEWER> {
  return role === ROLES.ADMIN || role === ROLES.MEMBER
}

export const ROLE_CONFIG: Record<Role, { title: string; badgeVariant: string; description: string }> = {
  viewer: { title: 'Viewer', badgeVariant: 'secondary', description: 'Read-only access' },
  member: { title: 'Member', badgeVariant: 'default', description: 'Can create and edit own content' },
  admin: { title: 'Admin', badgeVariant: 'warning', description: 'Full access to all features' },
}
