/**
 * The humanizer parses strings the server actually sends.
 *
 * Its `writableFields` branch used to match `FIELD ERROR: Cannot update field
 * '<f>' … role '<r>'` — a sentence that appears nowhere in the SDK. Every real
 * refusal fell through to the generic `Field not editable` with an empty
 * detail, which is the least actionable message the SDK produces: no field, no
 * role, no collection.
 *
 * The server strings below are the ones the record path emits, verbatim; see
 * `server/handlers/__tests__/record-permissions.test.ts`, which asserts the
 * same text on the way out.
 */

import { describe, expect, it } from 'vitest'
import { parseServerError } from '../serverErrors'

describe('parseServerError', () => {
  it('names the role and the field a writableFields refusal was about', () => {
    expect(parseServerError("FIELD ERROR: Role 'member' cannot modify field 'internalState'")).toEqual(
      {
        title: `Members can't edit "internalState"`,
        detail: '',
        isPermissionError: true,
      },
    )
  })

  it('still falls back for the other FIELD ERROR shapes', () => {
    // System-managed columns and physical column ids carry their own remedy in
    // the server text; they are not role/field refusals.
    for (const error of [
      "FIELD ERROR: 'role' is system-managed and cannot be set by a record write — nothing was written.",
      "FIELD ERROR: physical column id 'col_title' is not a writable field; use 'title'",
      "FIELD ERROR: Role 'member' can set 'ownerId' only to their own user id or leave it unclaimed",
    ]) {
      expect(parseServerError(error)).toEqual({
        title: 'Field not editable',
        detail: '',
        isPermissionError: true,
      })
    }
  })

  it('keeps the RBAC denials it already handled', () => {
    expect(parseServerError('UPDATE DENIED: role=viewer, collection=rbac-notes')).toMatchObject({
      title: `Viewers can't edit Notes`,
      isPermissionError: true,
    })
    expect(parseServerError('boom')).toEqual({
      title: 'Error',
      detail: 'boom',
      isPermissionError: false,
    })
  })
})
