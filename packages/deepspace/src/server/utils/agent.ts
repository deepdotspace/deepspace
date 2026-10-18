import { isStepCount, streamText, type PrepareStepFunction, type ToolSet } from 'ai'
import {
  DEEPSPACE_AI_EFFORTS,
  resolveDeepSpaceAgentModel,
  type DeepSpaceAIEffort,
  type DeepSpaceAgentProfile,
  type DeepSpaceAgentProfileId,
  type ResolvedDeepSpaceAgentModel,
} from '../../shared/ai-models'
import type { SandboxScope } from '../../shared/sandbox'
import { createDeepSpaceAI, type DeepSpaceAIEnv } from './ai'
import { DEFAULT_CONTEXT_CONFIG, capToolResultSize } from './chat-context'

type StreamTextOptions<TOOLS extends ToolSet> = Parameters<typeof streamText<TOOLS>>[0]

export type DeepSpaceAgentStreamOptions<TOOLS extends ToolSet> = Omit<
  StreamTextOptions<TOOLS>,
  'model' | 'providerOptions' | 'reasoning' | 'stopWhen'
> & {
  profile: DeepSpaceAgentProfileId
  modelId?: unknown
  authToken?: string
  /** Scope for sandbox files and containers this turn creates (see `createDeepSpaceAI`). */
  sandboxScope?: SandboxScope
  /**
   * Tool calls allowed in one turn before the agent must reply (default 20,
   * 1 to 100). Only the application profile accepts an override.
   */
  maxToolCalls?: number
  /**
   * How much a Claude model thinks and writes, from `low` (fastest, cheapest)
   * to `max`. Defaults to the model's `agentEffort` (`medium` on Opus 5.5,
   * Sonnet 5.5 and Haiku 5.5). Models without an effort setting (GPT, Claude
   * Haiku 4.5) ignore it.
   */
  effort?: DeepSpaceAIEffort
}

export interface DeepSpaceAgentStream<TOOLS extends ToolSet> {
  selection: ResolvedDeepSpaceAgentModel
  result: ReturnType<typeof streamText<TOOLS>>
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

export class DeepSpaceAgentToolLimitError extends Error {
  readonly code = 'invalid_agent_tool_limit'

  constructor(
    readonly profile: DeepSpaceAgentProfileId,
    readonly maxToolCalls: unknown,
    ceiling: number | undefined,
  ) {
    super(
      ceiling === undefined
        ? `The ${profile} agent profile does not accept a maxToolCalls override`
        : `maxToolCalls must be a whole number from 1 to ${ceiling}, got ${String(maxToolCalls)}`,
    )
    this.name = 'DeepSpaceAgentToolLimitError'
  }
}

export class DeepSpaceAgentEffortError extends Error {
  readonly code = 'invalid_agent_effort'

  constructor(readonly effort: unknown) {
    super(`effort must be one of ${DEEPSPACE_AI_EFFORTS.join(', ')}, got ${String(effort)}`)
    this.name = 'DeepSpaceAgentEffortError'
  }
}

/** The sole provider/model/tool-loop implementation for every DeepSpace agent surface. */
export function streamDeepSpaceAgent<TOOLS extends ToolSet>(
  env: DeepSpaceAIEnv,
  options: DeepSpaceAgentStreamOptions<TOOLS>,
): DeepSpaceAgentStream<TOOLS> {
  const {
    profile,
    modelId,
    authToken,
    sandboxScope,
    maxToolCalls: requestedLimit,
    effort,
    ...streamOptions
  } = options
  const selection = resolveDeepSpaceAgentModel(modelId, profile)
  if (!selection) throw new DeepSpaceAgentModelError(modelId, profile)
  const maxToolCalls = resolveToolCallLimit(selection.profile, requestedLimit)
  if (effort !== undefined && !DEEPSPACE_AI_EFFORTS.includes(effort)) {
    throw new DeepSpaceAgentEffortError(effort)
  }
  if (selection.profile.allowedTools !== 'application-defined') {
    const allowed = selection.profile.allowedTools as readonly string[]
    for (const toolName of Object.keys(streamOptions.tools ?? {})) {
      if (!allowed.includes(toolName)) {
        throw new DeepSpaceAgentProfileError(profile, toolName)
      }
    }
  }

  const provider = createDeepSpaceAI(env, selection.provider, {
    ...(authToken ? { authToken } : {}),
    ...(sandboxScope ? { sandboxScope } : {}),
  })
  const { prepareStep, tools, ...remainingStreamOptions } = streamOptions
  const boundedTools = limitToolExecutions(capToolOutputs(tools), maxToolCalls)
  const result = streamText<TOOLS>({
    ...remainingStreamOptions,
    ...(boundedTools ? { tools: boundedTools } : {}),
    model: provider(selection.modelId),
    stopWhen: isStepCount(maxToolCalls + 1),
    prepareStep: enforceToolCallLimit(prepareStep, maxToolCalls),
    providerOptions: agentProviderOptions(selection, effort),
  } as StreamTextOptions<TOOLS>)

  return { selection, result }
}

function agentProviderOptions(
  selection: ResolvedDeepSpaceAgentModel,
  effort: DeepSpaceAIEffort | undefined,
): StreamTextOptions<ToolSet>['providerOptions'] {
  if (selection.provider === 'openai') return { openai: { reasoningEffort: 'none' } }
  if (!selection.model.agentEffort) return undefined
  return { anthropic: { effort: effort ?? selection.model.agentEffort } }
}

/**
 * Cap every tool's output where it enters the model's context. This is the
 * one place the model-facing budget applies, so it covers app-defined tools
 * as well as record tools, while the code inside a tool (and the executor it
 * calls) reads whole results. A streaming tool's iterable passes through:
 * the AI SDK detects streaming from `execute`'s direct return value.
 */
function capToolOutputs<TOOLS extends ToolSet>(tools: TOOLS | undefined): TOOLS | undefined {
  if (!tools) return tools
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      if (typeof definition.execute !== 'function') return [name, definition]
      const execute = definition.execute
      return [
        name,
        {
          ...definition,
          execute: (...args: Parameters<typeof execute>) => {
            const output: unknown = execute(...args)
            if (output !== null && typeof output === 'object' && Symbol.asyncIterator in output) {
              return output
            }
            return Promise.resolve(output).then((value) =>
              capToolResultSize(value, DEFAULT_CONTEXT_CONFIG.toolResultCap),
            )
          },
        },
      ]
    }),
  ) as TOOLS
}

function resolveToolCallLimit(profile: DeepSpaceAgentProfile, requested: unknown): number {
  const { maxToolCalls, maxToolCallsCeiling } = profile
  if (requested === undefined) return maxToolCalls
  const valid =
    maxToolCallsCeiling !== undefined &&
    Number.isInteger(requested) &&
    (requested as number) >= 1 &&
    (requested as number) <= maxToolCallsCeiling
  if (!valid) throw new DeepSpaceAgentToolLimitError(profile.id, requested, maxToolCallsCeiling)
  return requested as number
}

/**
 * The model-facing instruction for the step after the limit. Claude 5 models
 * reply with nothing when tools vanish mid-task unless told why, so the user
 * would see an empty answer.
 */
function toolLimitReachedMessage(maxToolCalls: number): string {
  return (
    `You have used all ${maxToolCalls} tool calls allowed in this turn, so tools are now ` +
    'unavailable. Reply to the user now using what you found so far: say what you did, ' +
    'what is still unfinished, and that they can ask you to continue.'
  )
}

function enforceToolCallLimit<TOOLS extends ToolSet>(
  prepareStep: PrepareStepFunction<TOOLS> | undefined,
  maxToolCalls: number,
): PrepareStepFunction<TOOLS> {
  return async (context) => {
    const prepared = await prepareStep?.(context)
    const completedToolCalls = context.steps.reduce(
      (count, step) => count + step.toolCalls.length,
      0,
    )
    if (completedToolCalls < maxToolCalls) return prepared
    return {
      ...prepared,
      activeTools: [],
      toolChoice: 'none',
      messages: [
        ...(prepared?.messages ?? context.messages),
        { role: 'user', content: toolLimitReachedMessage(maxToolCalls) },
      ],
    }
  }
}

function limitToolExecutions<TOOLS extends ToolSet>(
  tools: TOOLS | undefined,
  maxToolCalls: number,
): TOOLS | undefined {
  if (!tools) return tools
  let executions = 0
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      if (typeof definition.execute !== 'function') return [name, definition]
      const execute = definition.execute
      return [
        name,
        {
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
        },
      ]
    }),
  ) as TOOLS
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
  if (record.responseBody !== undefined) return undefined
  const message = current instanceof Error ? current.message : record.message
  if (typeof message !== 'string' || !message.trim()) return undefined
  return `message=${safeLogText(message)}`
}

function safeProviderResponseMetadata(responseBody: unknown): string[] {
  if (typeof responseBody !== 'string') return []
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>
    const error =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : undefined
    const code =
      typeof error?.code === 'string'
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
  const withoutControlCharacters = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('')

  return withoutControlCharacters
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[_ -]?key|authorization|password|secret|token)\b\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .trim()
    .slice(0, 300)
}
