import { describe, expect, it } from 'vitest'
import type { CollectionSchema } from '../../../shared/types'
import {
  canDelete,
  canRead,
  canUpdate,
  checkUnclaimedOwnerTransition,
  lintSchema,
  lintSchemas,
} from '../registry'

const claimableSchema: CollectionSchema = {
  name: 'tasks',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain' },
    { name: 'claimedById', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'claimedById',
  permissions: {
    member: {
      read: true,
      create: true,
      update: 'unclaimed-or-own',
      delete: 'own',
    },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

describe('own permissions without an identity', () => {
  const notes: CollectionSchema = {
    name: 'notes',
    columns: [{ name: 'text', storage: 'text', interpretation: 'plain' }],
    permissions: { viewer: { read: 'own', create: true, update: 'own', delete: 'own' } },
  }
  const anonymousNote = { data: { text: 'mine' }, createdBy: '' }

  it('gives an identity-less caller no ownership of identity-less records', () => {
    expect(canRead(notes, 'viewer', anonymousNote, '')).toBe(false)
    expect(canUpdate(notes, 'viewer', anonymousNote, '')).toBe(false)
    expect(canDelete(notes, 'viewer', anonymousNote, '')).toBe(false)
  })

  it('still lets an identified caller act on its own records', () => {
    expect(canUpdate(notes, 'viewer', { ...anonymousNote, createdBy: 'user-1' }, 'user-1')).toBe(
      true,
    )
  })

  it('does not count an identity-less caller as a collaborator', () => {
    const shared: CollectionSchema = {
      name: 'shared',
      columns: [{ name: 'collaborators', storage: 'text', interpretation: 'plain' }],
      collaboratorsField: 'collaborators',
      permissions: {
        viewer: { read: 'collaborator', create: true, update: 'collaborator', delete: 'own' },
      },
    }
    const record = { data: { collaborators: JSON.stringify(['']) }, createdBy: 'user-1' }
    expect(canRead(shared, 'viewer', record, '')).toBe(false)
    expect(canUpdate(shared, 'viewer', record, '')).toBe(false)
  })

  it('does not count an identity-less caller as a team member', () => {
    const docs: CollectionSchema = {
      name: 'docs',
      columns: [{ name: 'teamId', storage: 'text', interpretation: 'plain' }],
      teamField: 'teamId',
      permissions: { viewer: { read: 'team', create: true, update: 'team', delete: 'team' } },
    }
    const teamDoc = { data: { teamId: 'team-1' }, createdBy: 'user-1' }
    const ctx = {
      isTeamMember: (teamId: string, userId: string) => teamId === 'team-1' && userId === '',
    }
    expect(canRead(docs, 'viewer', teamDoc, '', ctx)).toBe(false)
    expect(canUpdate(docs, 'viewer', teamDoc, '', ctx)).toBe(false)
    expect(canDelete(docs, 'viewer', teamDoc, '', ctx)).toBe(false)
  })
})

describe('checkUnclaimedOwnerTransition', () => {
  it('allows an unclaimed row, a self-claim, and an unclaim', () => {
    expect(checkUnclaimedOwnerTransition(claimableSchema, 'member', {}, 'user-1')).toBeNull()
    expect(
      checkUnclaimedOwnerTransition(claimableSchema, 'member', { claimedById: 'user-1' }, 'user-1'),
    ).toBeNull()
    expect(
      checkUnclaimedOwnerTransition(claimableSchema, 'member', { claimedById: '' }, 'user-1'),
    ).toBeNull()
  })

  it('rejects assigning another user on either create or update', () => {
    expect(
      checkUnclaimedOwnerTransition(claimableSchema, 'member', { claimedById: 'user-2' }, 'user-1'),
    ).toContain('only to their own user id')
  })

  it('does not restrict trusted roles with unconditional update permission', () => {
    expect(
      checkUnclaimedOwnerTransition(claimableSchema, 'admin', { claimedById: 'user-2' }, 'admin-1'),
    ).toBeNull()
  })
})

describe('lintSchema claimable ownership', () => {
  it('accepts the server-enforced unclaimed-or-own pattern without userBound', () => {
    expect(lintSchema(claimableSchema)).toEqual([])
  })

  it('still warns for a spoofable ordinary own-permission schema', () => {
    const unsafe: CollectionSchema = {
      ...claimableSchema,
      permissions: {
        member: { read: true, create: true, update: 'own', delete: 'own' },
      },
    }
    expect(lintSchema(unsafe)).toHaveLength(1)
  })
})

describe('lintSchemas team level', () => {
  const incidents: CollectionSchema = {
    name: 'incidents',
    columns: [
      { name: 'teamId', storage: 'text', interpretation: 'plain' },
      { name: 'title', storage: 'text', interpretation: 'plain' },
    ],
    teamField: 'teamId',
    permissions: {
      member: { read: 'team', create: true, update: 'team', delete: false },
      admin: { read: true, create: true, update: true, delete: true },
    },
  }
  const teamMembers: CollectionSchema = {
    name: 'team_members',
    columns: [
      { name: 'teamId', storage: 'text', interpretation: 'plain' },
      { name: 'userId', storage: 'text', interpretation: 'plain' },
      { name: 'status', storage: 'text', interpretation: 'plain' },
    ],
    permissions: { admin: { read: true, create: true, update: true, delete: true } },
  }

  it("names the roles that use 'team' when no team_members collection is registered", () => {
    // Without team_members the level denies everything silently — it reads
    // as a sync bug, so the lint has to say it.
    const warnings = lintSchemas([incidents])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[incidents]')
    expect(warnings[0]).toContain('member')
    expect(warnings[0]).toContain("'team_members'")
  })

  it('is quiet once team_members is registered', () => {
    expect(lintSchemas([incidents, teamMembers])).toEqual([])
  })
})
