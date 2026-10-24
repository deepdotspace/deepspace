import { useState, type FormEvent } from 'react'
import { useQuery, useMutations } from 'deepspace'
import { APP_NAME } from '../../constants'

type Idea = { text: string; done: boolean }
export default function PublicBoard() {
  const { records, status } = useQuery<Idea>('ideas', { orderBy: 'createdAt', orderDir: 'desc' })
  const { ready, createConfirmed, putConfirmed } = useMutations<Idea>('ideas')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!text.trim() || !ready || busy) return
    setBusy(true)
    setError('')
    try {
      await createConfirmed({ text: text.trim(), done: false })
      setText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  async function toggle(id: string, done: boolean) {
    if (pending.has(id)) return
    setPending((current) => new Set(current).add(id))
    setError('')
    try {
      await putConfirmed(id, { done })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-semibold">{APP_NAME}</h1>
      <p className="mt-3 text-muted-foreground">
        A shared place for ideas. Anyone with this link can read, add, and complete items. Do not
        post private information.
      </p>
      <form onSubmit={save} className="my-8 flex gap-3">
        <input
          aria-label="New idea"
          value={text}
          disabled={busy}
          maxLength={280}
          onChange={(e) => setText(e.target.value)}
          placeholder="An idea worth keeping"
          className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2"
        />
        <button
          type="submit"
          disabled={!ready || busy || !text.trim()}
          className="rounded bg-primary px-5 py-2 text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Add idea'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {status === 'error' && <p role="alert">The board could not load. Try reloading.</p>}
      {status !== 'error' && (status === 'loading' || !ready) && (
        <p role="status">
          {records.length ? 'Reconnecting… Your ideas are still here.' : 'Connecting to the board…'}
        </p>
      )}
      {status === 'ready' && records.length === 0 && (
        <p>No ideas yet. Add the first one.</p>
      )}
      {records.length > 0 && (
        <ul className="divide-y divide-border">
          {records.map((record) => (
            <li key={record.recordId} aria-busy={pending.has(record.recordId)} className="flex items-start gap-3 py-4">
              <input
                type="checkbox"
                aria-label={`Complete ${record.data.text}`}
                checked={!!record.data.done}
                disabled={!ready || pending.has(record.recordId)}
                onChange={(e) => void toggle(record.recordId, e.target.checked)}
                className="mt-1"
              />
              <span className={record.data.done ? 'line-through text-muted-foreground' : ''}>
                {record.data.text}
              </span>
              {pending.has(record.recordId) && <span role="status">Saving…</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
