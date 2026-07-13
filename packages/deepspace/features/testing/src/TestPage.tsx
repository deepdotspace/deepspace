/**
 * TestPage — exercises RBAC and CRUD against the RecordRoom.
 *
 * Used by Playwright e2e tests to verify real data flow.
 * Displays current role, creates/reads/updates/deletes items.
 */

import { useState } from 'react'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { useUser } from 'deepspace'
import { useRecordContext } from 'deepspace'
import { useAuth } from 'deepspace'

interface ItemData {
  title: string
  description: string
  status: string
  createdBy: string
}

export default function TestPage() {
  const { isSignedIn } = useAuth()
  const { user } = useUser()
  const { roomRole } = useRecordContext()
  const { records: items, status } = useQuery<ItemData>('test-items')
  const isLoading = status === 'loading'
  const { createConfirmed, putConfirmed, removeConfirmed } = useMutations<ItemData>('test-items')

  const [lastResult, setLastResult] = useState<string>('')
  const [lastError, setLastError] = useState<string>('')

  const clearStatus = () => { setLastResult(''); setLastError('') }

  const tryCreate = async () => {
    clearStatus()
    try {
      const id = await createConfirmed({ title: 'Test Item', description: 'Created by test', status: 'draft', createdBy: user?.id ?? 'anonymous' })
      setLastResult(`created:${id}`)
    } catch (e: unknown) {
      setLastError(e instanceof Error ? e.message : String(e))
    }
  }

  const tryCreatePublished = async () => {
    clearStatus()
    try {
      const id = await createConfirmed({ title: 'Public Item', description: 'Visible to anonymous', status: 'published', createdBy: user?.id ?? 'anonymous' })
      setLastResult(`created:${id}`)
    } catch (e: unknown) {
      setLastError(e instanceof Error ? e.message : String(e))
    }
  }

  const tryUpdate = async (recordId: string) => {
    clearStatus()
    try {
      await putConfirmed(recordId, { title: 'Updated Title', description: 'Updated by test', status: 'draft', createdBy: user?.id ?? 'anonymous' })
      setLastResult(`updated:${recordId}`)
    } catch (e: unknown) {
      setLastError(e instanceof Error ? e.message : String(e))
    }
  }

  const tryDelete = async (recordId: string) => {
    clearStatus()
    try {
      await removeConfirmed(recordId)
      setLastResult(`deleted:${recordId}`)
    } catch (e: unknown) {
      setLastError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8" data-testid="test-page">
      <div className="mb-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold text-foreground mb-2">Connection Status</h2>
        <div className="space-y-1 text-sm">
          <div>Signed in: <span data-testid="test-signed-in">{String(isSignedIn)}</span></div>
          <div>User ID: <span data-testid="test-user-id">{user?.id ?? 'none'}</span></div>
          <div>Role: <span data-testid="test-user-role">{roomRole ?? 'connecting'}</span></div>
          <div>User Name: <span data-testid="test-user-name">{user?.name ?? 'Anonymous'}</span></div>
        </div>
      </div>

      <div className="mb-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold text-foreground mb-2">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <button data-testid="test-create-item" onClick={tryCreate}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
            Create Draft Item
          </button>
          <button data-testid="test-create-published" onClick={tryCreatePublished}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
            Create Published Item
          </button>
        </div>
        <div className="mt-3 min-h-[2.25rem]">
          {lastResult && (
            <div data-testid="test-last-result" className="rounded bg-success/20 px-3 py-2 text-sm text-success">
              {lastResult}
            </div>
          )}
          {lastError && (
            <div data-testid="test-last-error" className="rounded bg-destructive/20 px-3 py-2 text-sm text-destructive">
              {lastError}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Items {isLoading ? '(loading...)' : `(${items?.length ?? 0})`}
        </h2>
        <div data-testid="test-items-list" className="space-y-2">
          {items?.map((item) => (
            <div key={item.recordId} data-testid={`test-item-${item.recordId}`}
              className="flex items-center justify-between rounded border border-border px-3 py-2">
              <div className="text-sm">
                <span className="font-medium text-foreground">{item.data.title}</span>
                <span className="ml-2 text-muted-foreground">({item.data.status})</span>
                <span className="ml-2 text-muted-foreground text-xs">by {item.data.createdBy}</span>
              </div>
              <div className="flex gap-1">
                <button data-testid={`test-update-${item.recordId}`} onClick={() => tryUpdate(item.recordId)}
                  className="rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:opacity-90">
                  Update
                </button>
                <button data-testid={`test-delete-${item.recordId}`} onClick={() => tryDelete(item.recordId)}
                  className="rounded bg-destructive/20 px-2 py-1 text-xs text-destructive hover:opacity-90">
                  Delete
                </button>
              </div>
            </div>
          ))}
          {!isLoading && (!items || items.length === 0) && (
            <div data-testid="test-items-empty" className="text-sm text-muted-foreground">No items</div>
          )}
        </div>
      </div>
    </div>
  )
}
