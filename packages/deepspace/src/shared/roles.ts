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

export const ROLE_CONFIG: Record<Role, { title: string; badgeVariant: string; description: string }> = {
  viewer: { title: 'Viewer', badgeVariant: 'secondary', description: 'Read-only access' },
  member: { title: 'Member', badgeVariant: 'default', description: 'Can create and edit own content' },
  admin: { title: 'Admin', badgeVariant: 'warning', description: 'Full access to all features' },
}
