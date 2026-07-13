/**
 * Leaderboard Feature - Constants
 */

import type { BadgeProps } from '@/components/ui'

export type BadgeVariant = BadgeProps['variant']

export const LEADERBOARD_CATEGORY = {
  GENERAL: 'general',
  SPEED: 'speed',
  ACCURACY: 'accuracy',
} as const

export type LeaderboardCategory = typeof LEADERBOARD_CATEGORY[keyof typeof LEADERBOARD_CATEGORY]

export const CATEGORY_CONFIG: Record<LeaderboardCategory, { title: string; color: BadgeVariant }> = {
  [LEADERBOARD_CATEGORY.GENERAL]: { title: 'General', color: 'info' },
  [LEADERBOARD_CATEGORY.SPEED]: { title: 'Speed', color: 'warning' },
  [LEADERBOARD_CATEGORY.ACCURACY]: { title: 'Accuracy', color: 'success' },
}
