import { describe, expect, it } from 'vitest'
import {
  deriveDocumentsAccessChange,
  detectDocumentsAclEvent,
  isDocumentsOwner,
  resolveDocumentsAccessRole,
} from '../use-documents-presence-access'

describe('document access policy', () => {
  const document = {
    data: {
      ownerId: 'owner',
      collaborators: JSON.stringify(['editor', 'viewer']),
      editors: JSON.stringify(['editor']),
    },
  }

  it('resolves owner, editor, viewer, and no-access roles from the document ACL', () => {
    expect(resolveDocumentsAccessRole(document, 'owner')).toBe('owner')
    expect(resolveDocumentsAccessRole(document, 'editor')).toBe('editor')
    expect(resolveDocumentsAccessRole(document, 'viewer')).toBe('viewer')
    expect(resolveDocumentsAccessRole(document, 'outsider')).toBe('none')
    expect(resolveDocumentsAccessRole(document, null)).toBe('none')
  })

  it('does not expose owner controls while both the document and user are loading', () => {
    expect(isDocumentsOwner(undefined, undefined)).toBe(false)
    expect(isDocumentsOwner(document, undefined)).toBe(false)
    expect(isDocumentsOwner(undefined, 'owner')).toBe(false)
    expect(isDocumentsOwner(document, 'owner')).toBe(true)
  })

  it('treats malformed ACL fields as empty lists', () => {
    const malformed = {
      data: { ownerId: 'owner', collaborators: '{broken', editors: JSON.stringify('editor') },
    }
    expect(resolveDocumentsAccessRole(malformed, 'editor')).toBe('none')
  })

  it('derives only actionable transitions from the session baseline', () => {
    expect(deriveDocumentsAccessChange('editor', 'viewer', null)).toBe('downgrade')
    expect(deriveDocumentsAccessChange('viewer', 'editor', null)).toBe('upgrade')
    expect(deriveDocumentsAccessChange('viewer', 'none', null)).toBe('revoked')
    expect(deriveDocumentsAccessChange('owner', 'owner', null)).toBeNull()
    expect(deriveDocumentsAccessChange(null, 'viewer', { kind: 'downgrade', at: 20 })).toBe('downgrade')
    expect(deriveDocumentsAccessChange('editor', 'viewer', { kind: 'revoked', at: 20 })).toBe('revoked')
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

    expect(detectDocumentsAclEvent(state, 'removed-user', 10)).toEqual({ kind: 'revoked', at: 20 })
    expect(detectDocumentsAclEvent(state, 'demoted-user', 10)).toEqual({
      kind: 'downgrade',
      at: 20,
    })
    expect(detectDocumentsAclEvent(state, 'promoted-user', 10)).toEqual({
      kind: 'upgrade',
      at: 20,
    })
    expect(detectDocumentsAclEvent(state, 'other-user', 10)).toBeNull()
    expect(detectDocumentsAclEvent(state, 'removed-user', 20)).toBeNull()
  })
})
