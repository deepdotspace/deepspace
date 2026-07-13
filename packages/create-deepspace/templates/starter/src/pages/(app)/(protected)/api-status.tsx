import { useAsyncResource, integration } from 'deepspace'

interface IntegrationCatalog {
  integrations?: Record<string, unknown> | unknown[]
}

export default function ApiStatusPage() {
  const catalog = useAsyncResource<IntegrationCatalog>(
    async (signal) => {
      const res = await integration.get<IntegrationCatalog>('', undefined, { signal })
      if (!res.success) throw new Error(res.error)
      return res.data ?? {}
    },
    [],
    { retry: 1, retryDelayMs: 500 },
  )

  const integrationCount = Array.isArray(catalog.data?.integrations)
    ? catalog.data.integrations.length
    : Object.keys(catalog.data?.integrations ?? {}).length

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API status</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A scaffolded pattern for server-backed resources with explicit loading, error, empty, and retry states.
        </p>
      </div>

      {catalog.error && catalog.data && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-sm font-medium text-warning">Showing the last loaded catalog</p>
          <p className="mt-1 text-sm text-muted-foreground">{catalog.error}</p>
        </div>
      )}

      {catalog.status === 'loading' ? (
        <div className="flex items-center justify-center gap-3 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          Loading integration catalog...
        </div>
      ) : catalog.status === 'error' ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
          <p className="text-sm font-medium text-destructive">Could not load API data</p>
          <div className="mt-1 flex flex-col gap-3 text-sm text-muted-foreground">
            <span>{catalog.error}</span>
            {catalog.retryCount > 0 && (
              <span>Retried {catalog.retryCount} time{catalog.retryCount === 1 ? '' : 's'} automatically.</span>
            )}
            <button
              type="button"
              onClick={catalog.reload}
              className="w-fit rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Retry
            </button>
          </div>
        </div>
      ) : integrationCount === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card px-4 py-16 text-center">
          <h3 className="text-lg font-semibold text-foreground">No integrations available</h3>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            The catalog loaded, but it did not return any integration definitions.
          </p>
        </div>
      ) : (
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-medium">Integration catalog ready</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {integrationCount} integration{integrationCount === 1 ? '' : 's'} available.
              </p>
            </div>
            {catalog.isRefreshing && (
              <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                Refreshing
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={catalog.reload}
            className="mt-4 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Refresh
          </button>
        </section>
      )}
    </div>
  )
}
