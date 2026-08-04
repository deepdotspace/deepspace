import { describe, expect, it } from 'vitest'
import {
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
} from '../messaging'

describe('messaging ownership fields', () => {
  it.each([
    [CHANNELS_SCHEMA, 'createdBy'],
    [MESSAGES_SCHEMA, 'authorId'],
    [REACTIONS_SCHEMA, 'userId'],
    [CHANNEL_MEMBERS_SCHEMA, 'userId'],
    [READ_RECEIPTS_SCHEMA, 'userId'],
  ])('binds %s ownership to the caller', (schema, ownerField) => {
    expect(schema.ownerField).toBe(ownerField)
    expect(schema.columns.find((column) => column.name === ownerField)).toMatchObject({
      userBound: true,
      immutable: true,
    })
  })
})
