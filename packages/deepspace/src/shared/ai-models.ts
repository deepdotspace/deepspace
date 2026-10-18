/**
 * Canonical DeepSpace model catalog and agent policy.
 *
 * Provider catalogs are discovery inputs, not a safe runtime allowlist: a
 * model is promoted here only after its tool loop, transport, pricing, and
 * streaming contract have been verified end to end through the DeepSpace
 * proxy. Every client picker and server agent profile consumes this module.
 */

export type DeepSpaceAIProvider = 'anthropic' | 'openai' | 'cerebras'
export type DeepSpaceAgentProfileId = 'application' | 'documentation'
export type DeepSpaceAgentSupport = 'multi-step' | 'single-step' | 'none'
/** Anthropic's effort levels: how much a Claude model thinks and writes. */
export const DEEPSPACE_AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type DeepSpaceAIEffort = (typeof DEEPSPACE_AI_EFFORTS)[number]

export interface DeepSpaceAIModel {
  id: string
  label: string
  provider: DeepSpaceAIProvider
  providerLabel: string
  family: string
  /** Whether the model is eligible for DeepSpace's server-owned agent loop. */
  agentSupport: DeepSpaceAgentSupport
  /** Profiles in which the model has passed the complete runtime contract. */
  agentProfiles: readonly DeepSpaceAgentProfileId[]
  /** Provider transport currently used by the DeepSpace proxy adapter. */
  transport: 'messages' | 'chat-completions'
  recommendation: 'frontier' | 'balanced' | 'fast' | 'available' | 'limited'
  /**
   * Effort level the agent sends when the app sets none. Present only on
   * models that take Anthropic's effort setting.
   */
  agentEffort?: DeepSpaceAIEffort
  note?: string
  /**
   * Superseded: still resolvable by id, so an app that saved it keeps working,
   * but left out of pickers and model lists.
   */
  legacy?: true
}

export interface DeepSpaceAgentProfile {
  id: DeepSpaceAgentProfileId
  defaultModel: string
  /** Default tool calls per turn; one more step is allowed for the final reply. */
  maxToolCalls: number
  /** Upper bound for a caller's `maxToolCalls` override; absent means the limit is fixed. */
  maxToolCallsCeiling?: number
  allowedTools: 'application-defined' | readonly string[]
}

/**
 * Versioned provenance for the provider catalogs used during the latest
 * promotion review. Keeping this in the shipped artifact makes selection
 * policy auditable without allowing a mutable upstream list to change a
 * deployed app underneath a commit.
 */
export const DEEPSPACE_MODEL_CATALOG_PROVENANCE = {
  version: '2026-10-13',
  verifiedAt: '2026-10-13',
  sources: {
    anthropic: 'https://platform.claude.com/docs/en/api/beta/models/list',
    openai: 'https://developers.openai.com/api/docs/models/all',
    cerebras: 'https://inference-docs.cerebras.ai/models/overview',
  },
} as const

const MULTI_STEP_AGENT_PROFILES = ['application', 'documentation'] as const

type MultiStepModelInput = Pick<
  DeepSpaceAIModel,
  'id' | 'label' | 'family' | 'recommendation' | 'agentEffort' | 'legacy'
>
type MultiStepProvider = Pick<DeepSpaceAIModel, 'provider' | 'providerLabel' | 'transport'>

function createMultiStepModelFactory<const Provider extends MultiStepProvider>(provider: Provider) {
  return <const Model extends MultiStepModelInput>(model: Model) => ({
    ...model,
    ...provider,
    agentSupport: 'multi-step' as const,
    agentProfiles: MULTI_STEP_AGENT_PROFILES,
  })
}

const anthropicModel = createMultiStepModelFactory({
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  transport: 'messages',
})

const openAIModel = createMultiStepModelFactory({
  provider: 'openai',
  providerLabel: 'OpenAI',
  transport: 'chat-completions',
})

const DIRECT_GENERATION_NOTE =
  'Available for direct generation; the current proxy adapter has not passed multi-step tool-result continuation.'

const RESPONSES_API_TOOLS_NOTE =
  'Available for direct generation; its tool calling requires the Responses API, which the DeepSpace proxy does not serve.'

function openAIDirectModel<const Model extends Pick<DeepSpaceAIModel, 'id' | 'label' | 'family'>>(model: Model) {
  return {
    ...model,
    provider: 'openai' as const,
    providerLabel: 'OpenAI',
    agentSupport: 'none' as const,
    agentProfiles: [],
    transport: 'chat-completions' as const,
    recommendation: 'limited' as const,
    note: RESPONSES_API_TOOLS_NOTE,
  }
}

export const DEEPSPACE_AI_MODELS = [
  anthropicModel({
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    family: 'Claude 5',
    recommendation: 'frontier',
    agentEffort: 'medium',
  }),
  anthropicModel({
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    family: 'Claude 5',
    recommendation: 'frontier',
    agentEffort: 'high',
  }),
  anthropicModel({
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    family: 'Claude 5',
    recommendation: 'balanced',
    agentEffort: 'medium',
  }),
  anthropicModel({
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    family: 'Claude 5',
    recommendation: 'fast',
    agentEffort: 'medium',
  }),
  openAIModel({
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    family: 'GPT-6',
    recommendation: 'balanced',
  }),
  openAIModel({
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    family: 'GPT-6',
    recommendation: 'fast',
  }),
  openAIDirectModel({ id: 'gpt-6-astra', label: 'GPT-6 Astra', family: 'GPT-6' }),
  openAIDirectModel({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'GPT-6' }),
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    provider: 'cerebras',
    providerLabel: 'Cerebras',
    family: 'GPT-OSS',
    agentSupport: 'single-step',
    agentProfiles: [],
    transport: 'chat-completions',
    recommendation: 'limited',
    note: DIRECT_GENERATION_NOTE,
  },
  {
    id: 'qwen-3.8-27b',
    label: 'Qwen 3.8 27B',
    provider: 'cerebras',
    providerLabel: 'Cerebras',
    family: 'Qwen 3.8',
    agentSupport: 'single-step',
    agentProfiles: [],
    transport: 'chat-completions',
    recommendation: 'limited',
    note: DIRECT_GENERATION_NOTE,
  },
  // Superseded models: still resolvable for apps that saved them.
  anthropicModel({ id: 'claude-opus-5', label: 'Claude Opus 5', family: 'Claude 5', recommendation: 'frontier', agentEffort: 'high', legacy: true }),
  anthropicModel({ id: 'claude-fable-5', label: 'Claude Fable 5', family: 'Claude 5', recommendation: 'frontier', agentEffort: 'high', legacy: true }),
  anthropicModel({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', family: 'Claude 5', recommendation: 'balanced', agentEffort: 'high', legacy: true }),
  anthropicModel({ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', family: 'Claude 4.5', recommendation: 'fast', legacy: true }),
  openAIModel({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', family: 'GPT-5.6', recommendation: 'frontier', legacy: true }),
  openAIModel({ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', family: 'GPT-5.6', recommendation: 'balanced', legacy: true }),
  openAIModel({ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', family: 'GPT-5.6', recommendation: 'fast', legacy: true }),
] as const satisfies readonly DeepSpaceAIModel[]

export const DEEPSPACE_AI_DEFAULTS = {
  agent: 'claude-opus-5-5',
  directGeneration: 'claude-opus-5-5',
  summarization: 'claude-haiku-5-5',
} as const satisfies Record<string, DeepSpaceAIModelId>

export const DEEPSPACE_AGENT_PROFILES = {
  application: {
    id: 'application',
    defaultModel: DEEPSPACE_AI_DEFAULTS.agent,
    maxToolCalls: 20,
    maxToolCallsCeiling: 100,
    allowedTools: 'application-defined',
  },
  documentation: {
    id: 'documentation',
    defaultModel: DEEPSPACE_AI_DEFAULTS.agent,
    maxToolCalls: 20,
    allowedTools: ['documentation_search', 'documentation_read'],
  },
} as const satisfies Record<DeepSpaceAgentProfileId, DeepSpaceAgentProfile>

export type DeepSpaceAIModelId = (typeof DEEPSPACE_AI_MODELS)[number]['id']

export function getDeepSpaceAIModel(modelId: unknown): DeepSpaceAIModel | null {
  if (typeof modelId !== 'string') return null
  return DEEPSPACE_AI_MODELS.find((model) => model.id === modelId) ?? null
}

export function listDeepSpaceAgentModels(
  profileId: DeepSpaceAgentProfileId = 'application',
): readonly DeepSpaceAIModel[] {
  const defaultModel = DEEPSPACE_AGENT_PROFILES[profileId].defaultModel
  return DEEPSPACE_AI_MODELS.filter((model: DeepSpaceAIModel) =>
    !model.legacy && (model.agentProfiles as readonly DeepSpaceAgentProfileId[]).includes(profileId),
  ).sort((left, right) => Number(right.id === defaultModel) - Number(left.id === defaultModel))
}

export interface ResolvedDeepSpaceAgentModel {
  modelId: string
  provider: DeepSpaceAIProvider
  model: DeepSpaceAIModel
  profile: DeepSpaceAgentProfile
}

export function resolveDeepSpaceAgentModel(
  modelId: unknown,
  profileId: DeepSpaceAgentProfileId = 'application',
): ResolvedDeepSpaceAgentModel | null {
  const profile = DEEPSPACE_AGENT_PROFILES[profileId]
  const resolvedId = modelId === undefined ? profile.defaultModel : modelId
  const model = getDeepSpaceAIModel(resolvedId)
  if (!model || !model.agentProfiles.includes(profileId)) return null
  return { modelId: model.id, provider: model.provider, model, profile }
}
