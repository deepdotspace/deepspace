/**
 * Leaderboard Page
 *
 * Demonstrates:
 * - useQuery for fetching ordered records
 * - useMutations for CRUD operations
 * - useUser for role-aware actions
 */

import { useState } from 'react'
import { BarChart3, Medal, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { ROLES, useMutations, useQuery, useUser, type Role } from 'deepspace'
import {
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Input,
  Label,
  Modal,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
  type BadgeProps,
} from '@/components/ui'

type BadgeVariant = BadgeProps['variant']

const LEADERBOARD_CATEGORY = {
  GENERAL: 'general',
  SPEED: 'speed',
  ACCURACY: 'accuracy',
} as const

type LeaderboardCategory = (typeof LEADERBOARD_CATEGORY)[keyof typeof LEADERBOARD_CATEGORY]

const CATEGORY_CONFIG: Record<LeaderboardCategory, { title: string; color: BadgeVariant }> = {
  [LEADERBOARD_CATEGORY.GENERAL]: { title: 'General', color: 'info' },
  [LEADERBOARD_CATEGORY.SPEED]: { title: 'Speed', color: 'warning' },
  [LEADERBOARD_CATEGORY.ACCURACY]: { title: 'Accuracy', color: 'success' },
}

interface LeaderboardEntry {
  playerName: string
  score: number
  category: LeaderboardCategory
  playerId: string
}

type LeaderboardRecord = {
  recordId: string
  data: LeaderboardEntry
}

interface LeaderboardPageProps {
  className?: string
}

interface SubmitScoreModalProps {
  onClose: () => void
  onSubmit: (playerName: string, score: number, category: LeaderboardCategory) => Promise<boolean>
  userName: string
}

function SubmitScoreModal({ onClose, onSubmit, userName }: SubmitScoreModalProps) {
  const [playerName, setPlayerName] = useState(userName)
  const [score, setScore] = useState('')
  const [category, setCategory] = useState<LeaderboardCategory>(LEADERBOARD_CATEGORY.GENERAL)
  const [submitting, setSubmitting] = useState(false)

  const parsedScore = Number(score)
  const isValid =
    playerName.trim().length > 0 && score.trim().length > 0 && Number.isFinite(parsedScore)

  const handleSubmit = async () => {
    if (!isValid || submitting) return

    setSubmitting(true)
    try {
      const submitted = await onSubmit(playerName.trim(), parsedScore, category)
      if (!submitted) return
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} size="sm">
      <Modal.Header>
        <Modal.Title>Submit Score</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div>
            <Label htmlFor="leaderboard-player-name" className="mb-2 block">
              Player name
            </Label>
            <Input
              id="leaderboard-player-name"
              type="text"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="Your name"
              disabled={submitting}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="leaderboard-score" className="mb-2 block">
              Score
            </Label>
            <Input
              id="leaderboard-score"
              type="number"
              value={score}
              onChange={(event) => setScore(event.target.value)}
              placeholder="Enter your score"
              disabled={submitting}
            />
          </div>
          <div>
            <Label htmlFor="leaderboard-category" className="mb-2 block">
              Category
            </Label>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as LeaderboardCategory)}
              disabled={submitting}
            >
              <SelectTrigger id="leaderboard-category">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(LEADERBOARD_CATEGORY).map((value) => (
                  <SelectItem key={value} value={value}>
                    {CATEGORY_CONFIG[value].title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={() => void handleSubmit()} disabled={!isValid} loading={submitting}>
          Submit
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

interface EditScoreModalProps {
  entry: LeaderboardRecord
  onClose: () => void
  onSave: (entry: LeaderboardRecord, score: number) => Promise<boolean>
}

function EditScoreModal({ entry, onClose, onSave }: EditScoreModalProps) {
  const [score, setScore] = useState(String(entry.data.score))
  const [saving, setSaving] = useState(false)
  const parsedScore = Number(score)
  const isValid = score.trim().length > 0 && Number.isFinite(parsedScore)

  const handleSave = async () => {
    if (!isValid || saving) return

    setSaving(true)
    try {
      const saved = await onSave(entry, parsedScore)
      if (!saved) return
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={saving ? () => undefined : onClose} size="sm">
      <Modal.Header>
        <Modal.Title>Edit score for {entry.data.playerName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Label htmlFor="leaderboard-edit-score" className="mb-2 block">
          Score
        </Label>
        <Input
          id="leaderboard-edit-score"
          type="number"
          value={score}
          onChange={(event) => setScore(event.target.value)}
          disabled={saving}
          autoFocus
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={!isValid} loading={saving}>
          Save
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    const label = rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd'
    const variant: BadgeVariant = rank === 1 ? 'warning' : rank === 2 ? 'secondary' : 'outline'

    return (
      <Badge variant={variant} aria-label={`${label} place`}>
        <Medal aria-hidden="true" className="mr-1 size-3" />
        {label}
      </Badge>
    )
  }

  return <span className="text-sm font-medium text-muted-foreground">#{rank}</span>
}

export default function LeaderboardPage({ className }: LeaderboardPageProps) {
  const { user } = useUser()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const isAdmin = userRole === ROLES.ADMIN
  const canSubmit = userRole === ROLES.MEMBER || isAdmin
  const toast = useToast()

  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<LeaderboardRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LeaderboardRecord | null>(null)
  const [deleting, setDeleting] = useState(false)

  const {
    records: entries,
    status,
    error: queryError,
  } = useQuery<LeaderboardEntry>('leaderboard', {
    orderBy: 'score',
    orderDir: 'desc',
  })
  const { createConfirmed, putConfirmed, removeConfirmed } =
    useMutations<LeaderboardEntry>('leaderboard')

  const handleSubmit = async (
    playerName: string,
    score: number,
    category: LeaderboardCategory,
  ): Promise<boolean> => {
    if (!user) {
      toast.error('Could not submit score', 'Sign in and try again.')
      return false
    }

    try {
      await createConfirmed({ playerName, score, category, playerId: user.id })
      toast.success(
        'Score submitted',
        `${score.toLocaleString()} points recorded for "${playerName}".`,
      )
      return true
    } catch (error) {
      toast.error(
        'Could not submit score',
        error instanceof Error ? error.message : 'Please try again.',
      )
      return false
    }
  }

  const handleEditSave = async (entry: LeaderboardRecord, newScore: number): Promise<boolean> => {
    try {
      await putConfirmed(entry.recordId, { score: newScore })
      toast.success(
        'Score updated',
        `"${entry.data.playerName}" now has ${newScore.toLocaleString()} points.`,
      )
      return true
    } catch (error) {
      toast.error(
        'Could not update score',
        error instanceof Error ? error.message : 'Please try again.',
      )
      return false
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return

    setDeleting(true)
    try {
      await removeConfirmed(deleteTarget.recordId)
      toast.success('Score deleted', `The score for "${deleteTarget.data.playerName}" was deleted.`)
      setDeleteTarget(null)
    } catch (error) {
      toast.error(
        'Could not delete score',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      setDeleting(false)
    }
  }

  const isLoading = status === 'loading'

  return (
    <div className={`h-full overflow-y-auto bg-background ${className ?? ''}`}>
      <div className="sticky top-0 z-10 border-b border-border bg-card/60 backdrop-blur-md">
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Leaderboard</h1>
              <p className="mt-1 text-muted-foreground">
                {isLoading
                  ? 'Loading current rankings...'
                  : canSubmit
                    ? 'Submit a score and see where you rank.'
                    : 'Scores are ranked from highest to lowest.'}
              </p>
            </div>

            {canSubmit && (
              <Button onClick={() => setShowSubmitModal(true)}>
                <Plus aria-hidden="true" />
                Submit Score
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        {isLoading ? (
          <div
            className="space-y-3 rounded-xl border border-border bg-card/60 p-4"
            aria-label="Loading leaderboard"
            aria-busy="true"
          >
            <div className="h-8 animate-pulse rounded-md bg-muted/60" />
            <div className="h-12 animate-pulse rounded-md bg-muted/40" />
            <div className="h-12 animate-pulse rounded-md bg-muted/40" />
            <div className="h-12 animate-pulse rounded-md bg-muted/40" />
          </div>
        ) : status === 'error' ? (
          <EmptyState
            title="Could not load leaderboard"
            description={queryError ?? 'Refresh the page to try again.'}
            icon={<TriangleAlert aria-hidden="true" />}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            title="No scores yet"
            description={
              canSubmit
                ? 'Submit the first score to start the leaderboard.'
                : 'Scores will appear here after a member submits one.'
            }
            icon={<BarChart3 aria-hidden="true" />}
            action={
              canSubmit
                ? { label: 'Submit a score', onClick: () => setShowSubmitModal(true) }
                : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card/60">
            <table className="w-full min-w-160">
              <caption className="sr-only">Scores ranked from highest to lowest</caption>
              <thead>
                <tr className="border-b border-border">
                  <th className="w-20 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Rank
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Player
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Category
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Score
                  </th>
                  {canSubmit && (
                    <th className="w-24 px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {entries.map((entry, index) => {
                  const rank = index + 1
                  const isOwn = entry.data.playerId === user?.id
                  const categoryConfig =
                    CATEGORY_CONFIG[entry.data.category] ??
                    CATEGORY_CONFIG[LEADERBOARD_CATEGORY.GENERAL]
                  const canManage = isOwn || isAdmin

                  return (
                    <tr
                      key={entry.recordId}
                      className={`transition-colors ${
                        isOwn ? 'bg-primary/10' : 'hover:bg-muted/30'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <RankBadge rank={rank} />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-medium ${isOwn ? 'text-primary' : 'text-foreground'}`}
                        >
                          {entry.data.playerName}
                        </span>
                        {isOwn && <span className="ml-2 text-xs text-primary">(you)</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={categoryConfig.color} size="sm">
                          {categoryConfig.title}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-foreground">
                        {entry.data.score.toLocaleString()}
                      </td>
                      {canSubmit && (
                        <td className="px-4 py-3 text-right">
                          {canManage && (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-muted-foreground"
                                onClick={() => setEditingEntry(entry)}
                                aria-label={`Edit score for ${entry.data.playerName}`}
                              >
                                <Pencil aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                                onClick={() => setDeleteTarget(entry)}
                                aria-label={`Delete score for ${entry.data.playerName}`}
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showSubmitModal && (
        <SubmitScoreModal
          onClose={() => setShowSubmitModal(false)}
          onSubmit={handleSubmit}
          userName={user?.name ?? ''}
        />
      )}

      {editingEntry && (
        <EditScoreModal
          key={editingEntry.recordId}
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onSave={handleEditSave}
        />
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void handleDelete()}
        title={
          deleteTarget ? `Delete score for "${deleteTarget.data.playerName}"?` : 'Delete score?'
        }
        description={
          deleteTarget
            ? `This permanently removes the ${deleteTarget.data.score.toLocaleString()}-point score.`
            : 'This cannot be undone.'
        }
        confirmText="Delete"
        loading={deleting}
      />
    </div>
  )
}
