/**
 * Items Feature - Constants
 */

export const ITEM_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const

export type ItemStatus = typeof ITEM_STATUS[keyof typeof ITEM_STATUS]
