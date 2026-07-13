/**
 * Tasks Page (Challenges)
 *
 * Demonstrates:
 * - 'unclaimed-or-own' permission for claimable tasks
 * - writableFields for restricting which fields can be updated
 * - timestampTrigger for automatic timestamps
 * - Admin grading workflow
 */

import { useState, useMemo } from 'react'
import { useUser } from 'deepspace'
import { useUsers } from 'deepspace'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { Button, Modal, Badge, EmptyState } from '@/components/ui'
import { ROLES, type Role } from 'deepspace'
import { DIFFICULTY, DIFFICULTY_CONFIG, GRADE, GRADE_CONFIG, type Difficulty, type Grade, type BadgeVariant } from '../components/tasks/tasks-constants'

// Tailwind color classes for buttons (semantic colors)
const buttonColorClasses: Record<NonNullable<BadgeVariant>, string> = {
  default: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-info',
  secondary: 'text-muted-foreground',
  outline: 'text-foreground',
}

// ============================================================================
// Types
// ============================================================================

interface Challenge {
  title: string
  description: string
  difficulty: string
  points: number
  claimedById?: string
  claimedAt?: string
  submitted: boolean
  submissionUrl?: string
  submissionNotes?: string
  submittedAt?: string
  grade?: string
  feedback?: string
  gradedById?: string
  gradedAt?: string
  createdById: string
}

interface TasksPageProps {
  className?: string
}

// ============================================================================
// Create Challenge Modal
// ============================================================================

interface CreateChallengeModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (title: string, description: string, difficulty: Difficulty) => void
}

function CreateChallengeModal({ isOpen, onClose, onCreate }: CreateChallengeModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>(DIFFICULTY.MEDIUM)

  const handleSubmit = () => {
    if (title.trim() && description.trim()) {
      onCreate(title.trim(), description.trim(), difficulty)
      setTitle('')
      setDescription('')
      setDifficulty(DIFFICULTY.MEDIUM)
      onClose()
    }
  }

  return (
    <Modal open={isOpen} onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>
        <Modal.Title>Create Challenge</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Challenge title"
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the challenge..."
              rows={3}
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Difficulty</label>
            <div className="flex gap-2">
              {Object.entries(DIFFICULTY_CONFIG).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => setDifficulty(key as Difficulty)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border ${buttonColorClasses[config.color ?? 'default']} ${
                    difficulty === key
                      ? 'border-primary/30 bg-primary/20'
                      : 'border-border bg-muted/40 hover:bg-muted/60'
                  }`}
                >
                  {config.title} ({config.points} pts)
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!title.trim() || !description.trim()}>
          Create Challenge
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Submit Modal
// ============================================================================

interface SubmitModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (url: string, notes: string) => void
  challenge: { recordId: string; data: Challenge } | null
}

function SubmitModal({ isOpen, onClose, onSubmit, challenge }: SubmitModalProps) {
  const [url, setUrl] = useState('')
  const [notes, setNotes] = useState('')

  const handleSubmit = () => {
    onSubmit(url.trim(), notes.trim())
    setUrl('')
    setNotes('')
    onClose()
  }

  if (!challenge) return null

  return (
    <Modal open={isOpen} onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>
        <Modal.Title>Submit Challenge</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div className="p-3 bg-muted/40 rounded-lg border border-border/30">
            <h4 className="font-medium text-foreground">{challenge.data.title}</h4>
            <p className="text-sm text-muted-foreground mt-1">{challenge.data.description}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Submission URL (optional)</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe your solution..."
              rows={3}
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring resize-none"
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit}>Submit</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Grade Modal (Admin only)
// ============================================================================

interface GradeModalProps {
  isOpen: boolean
  onClose: () => void
  onGrade: (grade: Grade, feedback: string) => void
  challenge: { recordId: string; data: Challenge } | null
}

function GradeModal({ isOpen, onClose, onGrade, challenge }: GradeModalProps) {
  const [grade, setGrade] = useState<Grade>(GRADE.PASS)
  const [feedback, setFeedback] = useState('')

  const handleSubmit = () => {
    onGrade(grade, feedback.trim())
    setGrade(GRADE.PASS)
    setFeedback('')
    onClose()
  }

  if (!challenge) return null

  return (
    <Modal open={isOpen} onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>
        <Modal.Title>Grade Submission</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div className="p-3 bg-muted/40 rounded-lg border border-border/30">
            <h4 className="font-medium text-foreground">{challenge.data.title}</h4>
            {challenge.data.submissionUrl && (
              <a
                href={challenge.data.submissionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline mt-1 block"
              >
                {challenge.data.submissionUrl}
              </a>
            )}
            {challenge.data.submissionNotes && (
              <p className="text-sm text-muted-foreground mt-2">{challenge.data.submissionNotes}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Grade</label>
            <div className="flex gap-2">
              {Object.entries(GRADE_CONFIG).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => setGrade(key as Grade)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border ${buttonColorClasses[config.color ?? 'default']} ${
                    grade === key
                      ? 'border-primary/30 bg-primary/20'
                      : 'border-border bg-muted/40 hover:bg-muted/60'
                  }`}
                >
                  {config.title}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Feedback</label>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Provide feedback..."
              rows={3}
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring resize-none"
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit}>Save Grade</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Challenge Card
// ============================================================================

interface ChallengeCardProps {
  challenge: { recordId: string; data: Challenge; createdAt: string }
  currentUserId?: string
  isAdmin: boolean
  getUserName: (id: string) => string
  onClaim: () => void
  onUnclaim: () => void
  onSubmit: () => void
  onGrade: () => void
}

function ChallengeCard({
  challenge,
  currentUserId,
  isAdmin,
  getUserName,
  onClaim,
  onUnclaim,
  onSubmit,
  onGrade,
}: ChallengeCardProps) {
  const { data } = challenge
  const difficultyConfig = DIFFICULTY_CONFIG[data.difficulty as Difficulty] ?? DIFFICULTY_CONFIG[DIFFICULTY.MEDIUM]
  const gradeConfig = data.grade ? GRADE_CONFIG[data.grade as Grade] : null

  const isClaimed = !!data.claimedById
  const isClaimedByMe = data.claimedById === currentUserId
  const isSubmitted = data.submitted
  const isGraded = !!data.grade

  // Determine status
  let status: 'available' | 'claimed' | 'submitted' | 'graded' = 'available'
  if (isGraded) status = 'graded'
  else if (isSubmitted) status = 'submitted'
  else if (isClaimed) status = 'claimed'

  const statusConfig: Record<typeof status, { label: string; color: BadgeVariant }> = {
    available: { label: 'Available', color: 'success' },
    claimed: { label: isClaimedByMe ? 'Claimed by you' : 'Claimed', color: 'warning' },
    submitted: { label: 'Submitted', color: 'info' },
    graded: { label: gradeConfig?.title ?? 'Graded', color: gradeConfig?.color ?? 'default' },
  }

  return (
    <div className="p-4 bg-card/60 rounded-xl border border-border">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{data.title}</h3>
            <Badge variant={difficultyConfig.color} size="sm">
              {difficultyConfig.title}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">{data.description}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-bold text-primary">{data.points}</div>
          <div className="text-xs text-muted-foreground">points</div>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between mb-3">
        <Badge variant={statusConfig[status].color} size="sm">{statusConfig[status].label}</Badge>
        {isClaimed && !isClaimedByMe && (
          <span className="text-xs text-muted-foreground">
            by {getUserName(data.claimedById!)}
          </span>
        )}
      </div>

      {/* Feedback (if graded) */}
      {isGraded && data.feedback && (
        <div className="p-2 bg-muted/40 rounded-lg mb-3 border border-border/30">
          <p className="text-xs text-muted-foreground mb-1">Feedback</p>
          <p className="text-sm text-muted-foreground">{data.feedback}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {/* Claim/Unclaim */}
        {!isClaimed && !isAdmin && (
          <Button size="sm" onClick={onClaim}>Claim</Button>
        )}
        {isClaimedByMe && !isSubmitted && (
          <>
            <Button size="sm" onClick={onSubmit}>Submit</Button>
            <Button size="sm" variant="secondary" onClick={onUnclaim}>Unclaim</Button>
          </>
        )}

        {/* Admin: Grade */}
        {isAdmin && isSubmitted && !isGraded && (
          <Button size="sm" onClick={onGrade}>Grade</Button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Main Page
// ============================================================================

export default function TasksPage({ className }: TasksPageProps) {
  const { user } = useUser()
  const { users } = useUsers()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const isAdmin = user?.role === 'admin'
  const canCreate = userRole === ROLES.MEMBER || isAdmin

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [submitChallenge, setSubmitChallenge] = useState<{ recordId: string; data: Challenge } | null>(null)
  const [gradeChallenge, setGradeChallenge] = useState<{ recordId: string; data: Challenge } | null>(null)
  const [filter, setFilter] = useState<'all' | 'available' | 'mine' | 'pending'>('all')

  // Query all challenges
  const { records: challenges, status } = useQuery<Challenge>('challenges', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })

  const { create, put } = useMutations<Challenge>('challenges')

  // Get user name helper
  const getUserName = (userId: string) => {
    const u = users.find(usr => usr.id === userId)
    return u?.name ?? 'Unknown'
  }

  // Filter challenges
  const filteredChallenges = useMemo(() => {
    return challenges.filter(c => {
      switch (filter) {
        case 'available':
          return !c.data.claimedById
        case 'mine':
          return c.data.claimedById === user?.id
        case 'pending':
          return c.data.submitted && !c.data.grade
        default:
          return true
      }
    })
  }, [challenges, filter, user?.id])

  // Handlers
  const handleCreate = async (title: string, description: string, difficulty: Difficulty) => {
    await create({
      title,
      description,
      difficulty,
      points: DIFFICULTY_CONFIG[difficulty].points,
      submitted: false,
      createdById: user!.id,
    })
  }

  const handleClaim = async (challenge: { recordId: string; data: Challenge }) => {
    await put(challenge.recordId, {
      ...challenge.data,
      claimedById: user!.id,
    })
  }

  const handleUnclaim = async (challenge: { recordId: string; data: Challenge }) => {
    await put(challenge.recordId, {
      ...challenge.data,
      claimedById: undefined,
    })
  }

  const handleSubmit = async (url: string, notes: string) => {
    if (!submitChallenge) return
    await put(submitChallenge.recordId, {
      ...submitChallenge.data,
      submitted: true,
      submissionUrl: url || undefined,
      submissionNotes: notes || undefined,
    })
    setSubmitChallenge(null)
  }

  const handleGrade = async (grade: Grade, feedback: string) => {
    if (!gradeChallenge) return
    await put(gradeChallenge.recordId, {
      ...gradeChallenge.data,
      grade,
      feedback: feedback || undefined,
      gradedById: user!.id,
    })
    setGradeChallenge(null)
  }

  const isLoading = status === 'loading'

  return (
    <div className={`h-full bg-background overflow-y-auto ${className ?? ''}`}>
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Challenges</h1>
              <p className="text-muted-foreground mt-1">
                Claim tasks, submit solutions, earn points
              </p>
            </div>

            {canCreate && (
              <Button onClick={() => setShowCreateModal(true)}>
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Challenge
              </Button>
            )}
          </div>

          {/* Filters */}
          <div className="flex gap-1 mt-4">
            {(['all', 'available', 'mine', ...(isAdmin ? ['pending'] as const : [])] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f as 'all' | 'available' | 'mine' | 'pending')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  filter === f
                    ? 'bg-primary/20 text-primary border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 border-transparent'
                }`}
              >
                {f === 'all' ? 'All' : f === 'available' ? 'Available' : f === 'mine' ? 'My Claims' : 'Pending Review'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : filteredChallenges.length === 0 ? (
          <EmptyState
            title={filter === 'all' ? 'No challenges yet' : `No ${filter} challenges`}
            description={
              filter === 'available'
                ? 'All challenges have been claimed'
                : filter === 'mine'
                  ? "You haven't claimed any challenges yet"
                  : canCreate
                    ? 'Create the first challenge to get started'
                    : 'No challenges have been created yet'
            }
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {filteredChallenges.map(challenge => (
              <ChallengeCard
                key={challenge.recordId}
                challenge={challenge}
                currentUserId={user?.id}
                isAdmin={isAdmin}
                getUserName={getUserName}
                onClaim={() => handleClaim(challenge)}
                onUnclaim={() => handleUnclaim(challenge)}
                onSubmit={() => setSubmitChallenge(challenge)}
                onGrade={() => setGradeChallenge(challenge)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateChallengeModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreate}
      />

      <SubmitModal
        isOpen={!!submitChallenge}
        onClose={() => setSubmitChallenge(null)}
        onSubmit={handleSubmit}
        challenge={submitChallenge}
      />

      <GradeModal
        isOpen={!!gradeChallenge}
        onClose={() => setGradeChallenge(null)}
        onGrade={handleGrade}
        challenge={gradeChallenge}
      />
    </div>
  )
}
