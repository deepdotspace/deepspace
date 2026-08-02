import { describe, expect, it } from 'vitest'
import {
  deriveDocsAccessChange,
  detectDocsAclEvent,
  isDocsOwner,
  resolveDocsAccessRole,
} from '../use-docs-presence-access'

describe('document access policy', () => {
  const document = {
    data: {
      ownerId: 'owner',
      collaborators: JSON.stringify(['editor', 'viewer']),
      editors: JSON.stringify(['editor']),
    },
  }

  it('resolves owner, editor, viewer, and no-access roles from the document ACL', () => {
    expect(resolveDocsAccessRole(document, 'owner')).toBe('owner')
    expect(resolveDocsAccessRole(document, 'editor')).toBe('editor')
    expect(resolveDocsAccessRole(document, 'viewer')).toBe('viewer')
    expect(resolveDocsAccessRole(document, 'outsider')).toBe('none')
    expect(resolveDocsAccessRole(document, null)).toBe('none')
  })

  it('does not expose owner controls while both the document and user are loading', () => {
    expect(isDocsOwner(undefined, undefined)).toBe(false)
    expect(isDocsOwner(document, undefined)).toBe(false)
    expect(isDocsOwner(undefined, 'owner')).toBe(false)
    expect(isDocsOwner(document, 'owner')).toBe(true)
  })

  it('treats malformed ACL fields as empty lists', () => {
    const malformed = {
      data: { ownerId: 'owner', collaborators: '{broken', editors: JSON.stringify('editor') },
    }
    expect(resolveDocsAccessRole(malformed, 'editor')).toBe('none')
  })

  it('derives only actionable transitions from the session baseline', () => {
    expect(deriveDocsAccessChange('editor', 'viewer', null)).toBe('downgrade')
    expect(deriveDocsAccessChange('viewer', 'editor', null)).toBe('upgrade')
    expect(deriveDocsAccessChange('viewer', 'none', null)).toBe('revoked')
    expect(deriveDocsAccessChange('owner', 'owner', null)).toBeNull()
    expect(deriveDocsAccessChange(null, 'viewer', { kind: 'downgrade', at: 20 })).toBe('downgrade')
    expect(deriveDocsAccessChange('editor', 'viewer', { kind: 'revoked', at: 20 })).toBe('revoked')
  })

  it('accepts only a fresh ACL signal addressed to the current user', () => {
    const state = {
      aclSignal: {
        at: 20,
        removed: ['removed-user'],
        demoted: ['demoted-user'],
        promoted: ['promoted-user'],
      },
    }

    expect(detectDocsAclEvent(state, 'removed-user', 10)).toEqual({ kind: 'revoked', at: 20 })
    expect(detectDocsAclEvent(state, 'demoted-user', 10)).toEqual({
      kind: 'downgrade',
      at: 20,
    })
    expect(detectDocsAclEvent(state, 'promoted-user', 10)).toEqual({
      kind: 'upgrade',
      at: 20,
    })
    expect(detectDocsAclEvent(state, 'other-user', 10)).toBeNull()
    expect(detectDocsAclEvent(state, 'removed-user', 20)).toBeNull()
  })
})
