/**
 * Tasks/Challenges Feature - Constants
 */

import type { BadgeProps } from '@/components/ui'

export type BadgeVariant = BadgeProps['variant']

// ============================================================================
// Difficulty
// ============================================================================

export const DIFFICULTY = {
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
} as const

export type Difficulty = typeof DIFFICULTY[keyof typeof DIFFICULTY]

export const DIFFICULTY_CONFIG: Record<Difficulty, { title: string; color: BadgeVariant; points: number }> = {
  [DIFFICULTY.EASY]: { title: 'Easy', color: 'success', points: 5 },
  [DIFFICULTY.MEDIUM]: { title: 'Medium', color: 'warning', points: 10 },
  [DIFFICULTY.HARD]: { title: 'Hard', color: 'destructive', points: 20 },
}

// ============================================================================
// Grade
// ============================================================================

export const GRADE = {
  PASS: 'pass',
  FAIL: 'fail',
  EXCELLENT: 'excellent',
} as const

export type Grade = typeof GRADE[keyof typeof GRADE]

export const GRADE_CONFIG: Record<Grade, { title: string; color: BadgeVariant; multiplier: number }> = {
  [GRADE.FAIL]: { title: 'Fail', color: 'destructive', multiplier: 0 },
  [GRADE.PASS]: { title: 'Pass', color: 'success', multiplier: 1 },
  [GRADE.EXCELLENT]: { title: 'Excellent', color: 'default', multiplier: 1.5 },
}
