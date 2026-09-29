import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The lookup signs its request with the app session's bearer token; the
// dialog imports it from the public `deepspace` entry, so mock that boundary.
vi.mock('deepspace', () => ({ getAuthToken: async () => 'jwt-123' }))

import { findDocumentsInvitee } from '../documents-invitee-lookup'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('findDocumentsInvitee', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the document id and email to the feature action with the session bearer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { found: true, userId: 'u-b' } }),
    )

    const result = await findDocumentsInvitee('doc-1', 'b@x.test')

    expect(result).toEqual({ found: true, userId: 'u-b' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/actions/documents-find-invitee')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer jwt-123')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ docId: 'doc-1', email: 'b@x.test' })
  })

  it('passes a not-found answer through unchanged', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { found: false } }))
    expect(await findDocumentsInvitee('doc-1', 'nobody@x.test')).toEqual({ found: false })
  })

  it("throws the action's own refusal text so the dialog can show it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: false, error: 'Only the document owner can share it' }),
    )
    await expect(findDocumentsInvitee('doc-1', 'b@x.test')).rejects.toThrow(
      'Only the document owner can share it',
    )
  })

  it('throws a status-bearing error when the route itself fails', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 502 }))
    await expect(findDocumentsInvitee('doc-1', 'b@x.test')).rejects.toThrow('Lookup failed (502)')
  })

  it('throws when the action route is missing (feature installed without its action)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Action not found' }))
    await expect(findDocumentsInvitee('doc-1', 'b@x.test')).rejects.toThrow('Action not found')
  })
})
