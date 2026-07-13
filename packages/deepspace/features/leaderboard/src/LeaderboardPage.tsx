/**
 * Leaderboard Page
 *
 * Demonstrates:
 * - useQuery for fetching records with ordering
 * - useMutations for CRUD operations
 * - useUser for current user
 * - Role-based UI (admin can edit anyone's score)
 */

import { useState } from 'react'
import { useUser } from 'deepspace'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { Button, Modal, EmptyState, Badge } from '@/components/ui'
import { ROLES, type Role } from 'deepspace'
import { LEADERBOARD_CATEGORY, CATEGORY_CONFIG, type LeaderboardCategory } from '../components/leaderboard/leaderboard-constants'

// ============================================================================
// Types
// ============================================================================

interface LeaderboardEntry {
  playerName: string
  score: number
  category: string
  playerId: string
}

interface LeaderboardPageProps {
  className?: string
}

// ============================================================================
// Submit Score Modal
// ============================================================================

interface SubmitScoreModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (playerName: string, score: number, category: string) => void
  userName: string
}

function SubmitScoreModal({ isOpen, onClose, onSubmit, userName }: SubmitScoreModalProps) {
  const [playerName, setPlayerName] = useState(userName)
  const [score, setScore] = useState('')
  const [category, setCategory] = useState<string>(LEADERBOARD_CATEGORY.GENERAL)

  const handleSubmit = () => {
    const parsed = Number(score)
    if (playerName.trim() && !isNaN(parsed)) {
      onSubmit(playerName.trim(), parsed, category)
      setPlayerName(userName)
      setScore('')
      setCategory(LEADERBOARD_CATEGORY.GENERAL)
      onClose()
    }
  }

  return (
    <Modal open={isOpen} onClose={onClose} size="sm">
      <Modal.Header onClose={onClose}>
        <Modal.Title>Submit Score</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Player Name</label>
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Your name"
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Score</label>
            <input
              type="number"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              placeholder="Enter your score"
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground focus:outline-none focus:ring-ring"
            >
              {Object.values(LEADERBOARD_CATEGORY).map(cat => (
                <option key={cat} value={cat}>{CATEGORY_CONFIG[cat].title}</option>
              ))}
            </select>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!playerName.trim() || !score}>Submit</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Edit Score Modal (Admin)
// ============================================================================

interface EditScoreModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (score: number) => void
  entry: { recordId: string; data: LeaderboardEntry } | null
}

function EditScoreModal({ isOpen, onClose, onSave, entry }: EditScoreModalProps) {
  const [score, setScore] = useState('')

  const handleOpen = () => {
    if (entry) setScore(String(entry.data.score))
  }

  const handleSave = () => {
    const parsed = Number(score)
    if (!isNaN(parsed)) {
      onSave(parsed)
      onClose()
    }
  }

  // Reset score when entry changes
  if (isOpen && entry && score === '') handleOpen()

  return (
    <Modal open={isOpen} onClose={onClose} size="sm">
      <Modal.Header onClose={onClose}>
        <Modal.Title>Edit Score - {entry?.data.playerName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Score</label>
          <input
            type="number"
            value={score}
            onChange={(e) => setScore(e.target.value)}
            className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
            autoFocus
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!score}>Save</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Rank Badge Component
// ============================================================================

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return <span className="text-lg" title="1st place">&#x1F947;</span>
  }
  if (rank === 2) {
    return <span className="text-lg" title="2nd place">&#x1F948;</span>
  }
  if (rank === 3) {
    return <span className="text-lg" title="3rd place">&#x1F949;</span>
  }
  return <span className="text-sm font-medium text-muted-foreground">#{rank}</span>
}

// ============================================================================
// Main Page
// ============================================================================

export default function LeaderboardPage({ className }: LeaderboardPageProps) {
  const { user } = useUser()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const isAdmin = userRole === ROLES.ADMIN
  const canSubmit = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN

  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<{ recordId: string; data: LeaderboardEntry } | null>(null)

  // Query all leaderboard entries, sorted by score descending
  const { records: entries, status } = useQuery<LeaderboardEntry>('leaderboard', {
    orderBy: 'score',
    orderDir: 'desc',
  })

  // Mutations for leaderboard
  const { create, put, remove } = useMutations<LeaderboardEntry>('leaderboard')

  const handleSubmit = async (playerName: string, score: number, category: string) => {
    await create({
      playerName,
      score,
      category,
      playerId: user!.id,
    })
  }

  const handleEditSave = async (newScore: number) => {
    if (editingEntry) {
      await put(editingEntry.recordId, { ...editingEntry.data, score: newScore })
      setEditingEntry(null)
    }
  }

  const handleDelete = async (recordId: string) => {
    if (confirm('Are you sure you want to delete this entry?')) {
      await remove(recordId)
    }
  }

  const isLoading = status === 'loading'

  return (
    <div className={`h-full bg-background overflow-y-auto ${className ?? ''}`}>
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Leaderboard</h1>
              <p className="text-muted-foreground mt-1">
                {canSubmit
                  ? 'Submit your score and compete for the top spot'
                  : 'View the rankings below'
                }
              </p>
            </div>

            {canSubmit && (
              <Button onClick={() => setShowSubmitModal(true)}>
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Submit Score
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title="No scores yet"
            description={canSubmit
              ? "Be the first to submit a score!"
              : "No scores have been submitted yet"
            }
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          />
        ) : (
          <div className="bg-card/60 rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-16">Rank</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Player</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Score</th>
                  {(canSubmit || isAdmin) && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {entries.map((entry, index) => {
                  const rank = index + 1
                  const isOwn = entry.data.playerId === user?.id
                  const cat = entry.data.category as LeaderboardCategory
                  const catConfig = CATEGORY_CONFIG[cat] ?? CATEGORY_CONFIG[LEADERBOARD_CATEGORY.GENERAL]

                  return (
                    <tr
                      key={entry.recordId}
                      className={`transition-colors ${isOwn ? 'bg-primary/20/10' : 'hover:bg-muted/30'}`}
                    >
                      <td className="px-4 py-3">
                        <RankBadge rank={rank} />
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-medium ${isOwn ? 'text-primary' : 'text-foreground'}`}>
                          {entry.data.playerName}
                        </span>
                        {isOwn && (
                          <span className="ml-2 text-xs text-primary">(you)</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={catConfig.color} size="sm">{catConfig.title}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-foreground">
                        {entry.data.score.toLocaleString()}
                      </td>
                      {(canSubmit || isAdmin) && (
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {(isOwn || isAdmin) && (
                              <button
                                onClick={() => setEditingEntry(entry)}
                                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-lg transition-colors"
                                title="Edit score"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                            )}
                            {(isOwn || isAdmin) && (
                              <button
                                onClick={() => handleDelete(entry.recordId)}
                                className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/20 rounded-lg transition-colors"
                                title="Delete"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
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

      {/* Submit Modal */}
      <SubmitScoreModal
        isOpen={showSubmitModal}
        onClose={() => setShowSubmitModal(false)}
        onSubmit={handleSubmit}
        userName={user?.name ?? ''}
      />

      {/* Edit Modal (admin or own) */}
      <EditScoreModal
        isOpen={!!editingEntry}
        onClose={() => setEditingEntry(null)}
        onSave={handleEditSave}
        entry={editingEntry}
      />
    </div>
  )
}
