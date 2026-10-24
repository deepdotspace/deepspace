/** Browser transport for the same server-owned tools used by HTTP and MCP. */
export interface BrowserModelContext {
  registerTool(
    tool: {
      name: string
      description: string
      inputSchema: unknown
      execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
    },
    options?: { signal: AbortSignal },
  ): void | Promise<void>
  // Older origin-trial implementations use navigator.modelContext and explicit cleanup.
  unregisterTool?: (name: string) => void
}

export interface ConnectAgentToolsOptions {
  /** A same-origin route; credentials can never be sent to another site. */
  basePath?: string
  /** Resolve the current token at execution time, never expose it as a tool argument. */
  getToken: (toolName?: string) => Promise<string | null>
  /** Update app-owned UI/session state from a completed tool call. */
  onResult?: (toolName: string, result: unknown) => void
  /** Abort on sign-out, account change, or component unmount. */
  signal?: AbortSignal
}

/** No plugin, polyfill or network request in browsers without native WebMCP. */
export async function connectAgentTools(options: ConnectAgentToolsOptions): Promise<{
  supported: boolean
  names: string[]
  dispose: () => void
}> {
  const context =
    typeof document === 'undefined'
      ? undefined
      : ((document as Document & { modelContext?: BrowserModelContext }).modelContext ??
        (typeof navigator === 'undefined'
          ? undefined
          : (navigator as Navigator & { modelContext?: BrowserModelContext }).modelContext))
  if (!context?.registerTool) return { supported: false, names: [], dispose() {} }
  const base = options.basePath ?? '/_deepspace/agent/browser'
  if (!/^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(base)) throw new Error('Use a same-origin agent route.')
  const controller = new AbortController()
  const names: string[] = []
  const dispose = () => {
    controller.abort()
    for (const name of names.splice(0)) context.unregisterTool?.(name)
    options.signal?.removeEventListener('abort', dispose)
  }
  options.signal?.addEventListener('abort', dispose, { once: true })
  if (options.signal?.aborted) dispose()
  const request = async (
    path: string,
    input?: unknown,
    signal?: AbortSignal,
    toolName?: string,
  ) => {
    controller.signal.throwIfAborted()
    const token = await options.getToken(toolName)
    controller.signal.throwIfAborted()
    const response = await fetch(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    })
    const body = (await response.json()) as {
      ok: boolean
      error?: string
      result?: unknown
      tools?: Array<{ name: string; description: string; inputSchema: unknown }>
    }
    if (!response.ok || !body.ok)
      throw new Error(body.error ?? `Agent request failed (${response.status}).`)
    return body
  }
  try {
    const { tools } = await request('/tools')
    if (!Array.isArray(tools)) throw new Error('Invalid agent tool list.')
    for (const tool of tools) {
      controller.signal.throwIfAborted()
      await context.registerTool(
        {
          name: tool.name,
          description: tool.description || tool.name,
          inputSchema: tool.inputSchema,
          execute: async (input, call) => {
            const result = (
              await request(
                `/tools/${encodeURIComponent(tool.name)}`,
                input ?? {},
                call?.signal,
                tool.name,
              )
            ).result
            controller.signal.throwIfAborted()
            options.onResult?.(tool.name, result)
            return result
          },
        },
        { signal: controller.signal },
      )
      names.push(tool.name)
      // Handles a slow registration that completed after sign-out in older browsers.
      if (controller.signal.aborted) {
        dispose()
        controller.signal.throwIfAborted()
      }
    }
    return { supported: true, names: [...names], dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
