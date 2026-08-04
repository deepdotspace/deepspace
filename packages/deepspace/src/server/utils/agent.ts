import {
  stepCountIs,
  streamText,
  type PrepareStepFunction,
  type StreamTextResult,
  type ToolSet,
} from 'ai'
import {
  resolveDeepSpaceAgentModel,
  type DeepSpaceAgentProfileId,
  type ResolvedDeepSpaceAgentModel,
} from '../../shared/ai-models'
import { createDeepSpaceAI, type DeepSpaceAIEnv } from './ai'

type StreamTextOptions<TOOLS extends ToolSet> = Parameters<typeof streamText<TOOLS>>[0]

export type DeepSpaceAgentStreamOptions<TOOLS extends ToolSet> = Omit<
  StreamTextOptions<TOOLS>,
  'model' | 'providerOptions' | 'stopWhen'
> & {
  profile: DeepSpaceAgentProfileId
  modelId?: unknown
  authToken?: string
}

export interface DeepSpaceAgentStream<TOOLS extends ToolSet> {
  selection: ResolvedDeepSpaceAgentModel
  result: StreamTextResult<TOOLS, never>
}

export class DeepSpaceAgentModelError extends Error {
  readonly code = 'unsupported_agent_model'

  constructor(readonly modelId: unknown, readonly profile: DeepSpaceAgentProfileId) {
    super(
      `Model ${typeof modelId === 'string' ? JSON.stringify(modelId) : String(modelId)} ` +
        `is not compatible with the ${profile} agent profile`,
    )
    this.name = 'DeepSpaceAgentModelError'
  }
}

export class DeepSpaceAgentProfileError extends Error {
  readonly code = 'agent_profile_violation'

  constructor(readonly profile: DeepSpaceAgentProfileId, readonly toolName: string) {
    super(`The ${profile} agent profile does not allow tool ${JSON.stringify(toolName)}`)
    this.name = 'DeepSpaceAgentProfileError'
  }
}

/**
 * Run every DeepSpace text agent through one provider, model, and tool-loop
 * implementation. Agent surfaces supply only their profile-specific prompt,
 * messages, tools, persistence callbacks, and access token.
 */
export function streamDeepSpaceAgent<TOOLS extends ToolSet>(
  env: DeepSpaceAIEnv,
  options: DeepSpaceAgentStreamOptions<TOOLS>,
): DeepSpaceAgentStream<TOOLS> {
  const { profile, modelId, authToken, ...streamOptions } = options
  const selection = resolveDeepSpaceAgentModel(modelId, profile)
  if (!selection) throw new DeepSpaceAgentModelError(modelId, profile)
  if (selection.profile.allowedTools !== 'application-defined') {
    const allowed = selection.profile.allowedTools as readonly string[]
    for (const toolName of Object.keys(streamOptions.tools ?? {})) {
      if (!allowed.includes(toolName)) {
        throw new DeepSpaceAgentProfileError(profile, toolName)
      }
    }
  }

  const provider = createDeepSpaceAI(
    env,
    selection.provider,
    authToken ? { authToken } : {},
  )
  const { prepareStep, tools, ...remainingStreamOptions } = streamOptions
  const boundedTools = limitToolExecutions(tools, selection.profile.maxToolCalls)
  const result = streamText<TOOLS>({
    ...remainingStreamOptions,
    ...(boundedTools ? { tools: boundedTools } : {}),
    model: provider(selection.modelId),
    stopWhen: stepCountIs(selection.profile.maxSteps),
    prepareStep: enforceToolCallLimit(prepareStep, selection.profile.maxToolCalls),
    ...(selection.provider === 'openai'
      ? { providerOptions: { openai: { reasoningEffort: 'none' as const } } }
      : {}),
  } as StreamTextOptions<TOOLS>)

  return { selection, result }
}

function enforceToolCallLimit<TOOLS extends ToolSet>(
  prepareStep: PrepareStepFunction<TOOLS> | undefined,
  maxToolCalls: number | undefined,
): PrepareStepFunction<TOOLS> | undefined {
  if (maxToolCalls === undefined) return prepareStep
  return async (context) => {
    const prepared = await prepareStep?.(context)
    const completedToolCalls = context.steps.reduce(
      (count, step) => count + step.toolCalls.length,
      0,
    )
    if (completedToolCalls < maxToolCalls) return prepared
    return { ...prepared, activeTools: [], toolChoice: 'none' }
  }
}

function limitToolExecutions<TOOLS extends ToolSet>(
  tools: TOOLS | undefined,
  maxToolCalls: number | undefined,
): TOOLS | undefined {
  if (!tools || maxToolCalls === undefined) return tools
  let executions = 0
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (typeof definition.execute !== 'function') return [name, definition]
    const execute = definition.execute
    return [name, {
      ...definition,
      execute: (...args: Parameters<typeof execute>) => {
        if (executions >= maxToolCalls) {
          return Promise.resolve({
            error: `The agent tool-call limit of ${maxToolCalls} has been reached`,
          })
        }
        executions++
        return execute(...args)
      },
    }]
  })) as TOOLS
}

export interface DeepSpaceAgentDiagnosticContext {
  profile?: DeepSpaceAgentProfileId
  provider?: string
  modelId?: string
}

/** Preserve safe structured provider diagnostics in bounded Worker logs. */
export function deepSpaceAgentErrorSummary(
  error: unknown,
  context: DeepSpaceAgentDiagnosticContext = {},
): string {
  const details: string[] = []
  const contextFields = [
    context.profile ? `profile=${context.profile}` : undefined,
    context.provider ? `provider=${safeLogToken(context.provider)}` : undefined,
    context.modelId ? `model=${safeLogToken(context.modelId)}` : undefined,
  ].filter((part): part is string => Boolean(part))
  if (contextFields.length > 0) details.push(contextFields.join(' '))
  const pending: unknown[] = [error]
  const visited = new Set<unknown>()
  while (pending.length > 0 && details.length < 8) {
    const current = pending.shift()
    if (current == null || visited.has(current)) continue
    visited.add(current)
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      const parts = [
        typeof record.name === 'string'
          ? `name=${safeLogToken(record.name)}`
          : current instanceof Error
            ? `name=${safeLogToken(current.name)}`
            : undefined,
        safeErrorMessage(current, record),
        typeof record.statusCode === 'number' ? `status=${record.statusCode}` : undefined,
        typeof record.code === 'string' ? `code=${safeLogToken(record.code)}` : undefined,
        typeof record.requestId === 'string'
          ? `requestId=${safeLogToken(record.requestId)}`
          : undefined,
        ...safeProviderResponseMetadata(record.responseBody),
      ].filter((part): part is string => Boolean(part))
      details.push(parts.join(' ') || Object.prototype.toString.call(current))
      if (record.lastError != null) pending.push(record.lastError)
      if (record.cause != null) pending.push(record.cause)
      if (Array.isArray(record.errors)) pending.push(...record.errors)
      continue
    }
    details.push(String(current))
  }
  return details.join(' <- ') || 'Unknown error'
}

function safeErrorMessage(current: object, record: Record<string, unknown>): string | undefined {
  // Provider response bodies sometimes contain prompt excerpts. When a body
  // exists, omit the adjacent message too; provider SDKs may concatenate it.
  if (record.responseBody !== undefined) return undefined
  const message = current instanceof Error ? current.message : record.message
  if (typeof message !== 'string' || !message.trim()) return undefined
  return `message=${safeLogText(message)}`
}

function safeProviderResponseMetadata(responseBody: unknown): string[] {
  if (typeof responseBody !== 'string') return []
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>
    const error = parsed.error && typeof parsed.error === 'object'
      ? parsed.error as Record<string, unknown>
      : undefined
    const code = typeof error?.code === 'string'
      ? error.code
      : typeof error?.type === 'string'
        ? error.type
        : undefined
    const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : undefined
    return [
      code ? `upstreamCode=${safeLogToken(code)}` : undefined,
      requestId ? `upstreamRequestId=${safeLogToken(requestId)}` : undefined,
    ].filter((part): part is string => Boolean(part))
  } catch {
    return []
  }
}

function safeLogToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:/-]/g, '_').slice(0, 120)
}

function safeLogText(value: string): string {
  const withoutControlCharacters = Array.from(value, character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('')

  return withoutControlCharacters
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_ -]?key|authorization|password|secret|token)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .trim()
    .slice(0, 300)
}
