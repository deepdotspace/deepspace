/**
 * Admin Page
 *
 * User management + app settings page.
 * - useUsers for listing all users
 * - setRole for changing user roles
 * - Admin-only settings collection
 * - useQuery with admin permissions
 */

import { useState, useMemo } from 'react'
import { useUser } from 'deepspace'
import { useUsers } from 'deepspace'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { Button, Badge, Avatar, AvatarFallback, useToast, type BadgeProps } from '@/components/ui'
import { ROLES, ROLE_CONFIG, type Role } from 'deepspace'

// ============================================================================
// Types
// ============================================================================

interface Setting {
  key: string
  value: string
}

// ============================================================================
// Main Page
// ============================================================================

export default function AdminPage() {
  const { user } = useUser()
  const isAdmin = user?.role === 'admin'
  const { users, setRole } = useUsers()
  const [activeTab, setActiveTab] = useState<'users' | 'settings'>('users')
  const toast = useToast()

  // Security: Don't render admin content if not an admin
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] bg-background">
        <div className="text-center">
          <div className="w-16 h-16 bg-destructive/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-destructive/40">
            <svg className="w-8 h-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-destructive mb-1">Access Denied</h2>
          <p className="text-muted-foreground text-sm">You don't have permission to view this page.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full bg-background overflow-y-auto">
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Admin Panel</h1>
              <p className="text-muted-foreground mt-1">Manage users and settings</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-4">
            <button
              onClick={() => setActiveTab('users')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'users'
                  ? 'bg-primary/20 text-primary border border-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent'
              }`}
            >
              Users ({users.length})
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'settings'
                  ? 'bg-primary/20 text-primary border border-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent'
              }`}
            >
              Settings
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'users' ? (
          <UsersPanel
            users={users}
            currentUserId={user?.id}
            onSetRole={(userId, role) => {
              setRole(userId, role)
              toast.success('Role updated successfully')
            }}
          />
        ) : (
          <SettingsPanel toast={toast} />
        )}
      </div>

    </div>
  )
}

// ============================================================================
// Users Panel
// ============================================================================

interface UsersPanelProps {
  users: Array<{
    id: string
    email: string
    name: string
    imageUrl?: string
    role: string
    lastSeenAt: string
  }>
  currentUserId?: string
  onSetRole: (userId: string, role: string) => void
}

function UsersPanel({ users, currentUserId, onSetRole }: UsersPanelProps) {
  // Sort users by last seen
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) =>
      new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
    )
  }, [users])

  return (
    <div className="space-y-4">
      <div className="bg-muted/40 rounded-xl border border-border overflow-hidden">
        <div className="divide-y divide-border/30">
          {sortedUsers.map(user => {
            const roleConfig = ROLE_CONFIG[user.role as Role] ?? ROLE_CONFIG[ROLES.VIEWER]
            const isCurrentUser = user.id === currentUserId

            return (
              <div key={user.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback>{user.name?.[0]?.toUpperCase() ?? '?'}</AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{user.name}</span>
                      {isCurrentUser && (
                        <span className="text-xs text-muted-foreground">(you)</span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <p className="text-xs text-muted-foreground">
                    Last seen: {new Date(user.lastSeenAt).toLocaleDateString()}
                  </p>

                  <div className="flex items-center gap-2">
                    <Badge variant={roleConfig.badgeVariant as BadgeProps['variant']}>{roleConfig.title}</Badge>
                    <select
                      value={user.role}
                      onChange={(e) => onSetRole(user.id, e.target.value)}
                      disabled={isCurrentUser}
                      className="px-3 py-1.5 bg-transparent border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-ring disabled:opacity-50"
                    >
                      {Object.entries(ROLE_CONFIG).map(([role, config]) => (
                        <option key={role} value={role}>
                          {config.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {users.length === 0 && (
        <p className="text-center text-muted-foreground py-8">No users found</p>
      )}
    </div>
  )
}

// ============================================================================
// Settings Panel
// ============================================================================

interface SettingsPanelProps {
  toast: ReturnType<typeof useToast>
}

function SettingsPanel({ toast }: SettingsPanelProps) {
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  // Query settings (admin-only collection)
  const { records: settings, status } = useQuery<Setting>('settings')
  const { create, remove } = useMutations<Setting>('settings')

  const handleCreate = async () => {
    if (!newKey.trim() || !newValue.trim()) return

    await create({ key: newKey.trim(), value: newValue.trim() })
    setNewKey('')
    setNewValue('')
    toast.success('Setting created')
  }

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this setting?')) {
      await remove(id)
      toast.success('Setting deleted')
    }
  }

  return (
    <div className="space-y-4">
      {/* Add new setting */}
      <div className="bg-muted/40 rounded-xl border border-border p-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-3">Add New Setting</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Key"
            className="flex-1 px-3 py-2 bg-transparent border border-border rounded-lg text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
          />
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Value"
            className="flex-1 px-3 py-2 bg-transparent border border-border rounded-lg text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
          />
          <Button onClick={handleCreate} disabled={!newKey.trim() || !newValue.trim()}>
            Add
          </Button>
        </div>
      </div>

      {/* Settings list */}
      <div className="bg-muted/40 rounded-xl border border-border overflow-hidden">
        {status === 'loading' ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : settings.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No settings configured</p>
        ) : (
          <div className="divide-y divide-border/30">
            {settings.map(setting => (
              <div key={setting.recordId} className="p-4 flex items-center justify-between">
                <div>
                  <code className="text-sm bg-muted px-2 py-1 rounded text-primary">
                    {setting.data.key}
                  </code>
                  <span className="text-muted-foreground mx-2">=</span>
                  <span className="text-foreground">{setting.data.value}</span>
                </div>
                <button
                  onClick={() => handleDelete(setting.recordId)}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/20 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
