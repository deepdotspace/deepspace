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
  note?: string
}

export interface DeepSpaceAgentProfile {
  id: DeepSpaceAgentProfileId
  defaultModel: string
  maxSteps: number
  maxToolCalls?: number
  allowedTools: 'application-defined' | readonly string[]
}

/**
 * Versioned provenance for the provider catalogs used during the latest
 * promotion review. Keeping this in the shipped artifact makes selection
 * policy auditable without allowing a mutable upstream list to change a
 * deployed app underneath a commit.
 */
export const DEEPSPACE_MODEL_CATALOG_PROVENANCE = {
  version: '2026-08-04',
  verifiedAt: '2026-08-04',
  sources: {
    anthropic: 'https://platform.claude.com/docs/en/api/beta/models/list',
    openai: 'https://developers.openai.com/api/docs/models/all',
    cerebras: 'https://inference-docs.cerebras.ai/models/overview',
  },
} as const

const MULTI_STEP_AGENT_PROFILES = ['application', 'documentation'] as const

type MultiStepModelInput = Pick<DeepSpaceAIModel, 'id' | 'label' | 'family' | 'recommendation'>
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

export const DEEPSPACE_AI_MODELS = [
  anthropicModel({
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    family: 'Claude 5',
    recommendation: 'frontier',
  }),
  anthropicModel({
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    family: 'Claude 5',
    recommendation: 'frontier',
  }),
  anthropicModel({
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    family: 'Claude 5',
    recommendation: 'balanced',
  }),
  anthropicModel({
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    family: 'Claude 4.5',
    recommendation: 'fast',
  }),
  openAIModel({
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    family: 'GPT-5.6',
    recommendation: 'frontier',
  }),
  openAIModel({
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    family: 'GPT-5.6',
    recommendation: 'balanced',
  }),
  openAIModel({
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    family: 'GPT-5.6',
    recommendation: 'fast',
  }),
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
    note: 'Available for direct generation; the current proxy adapter has not passed multi-step tool-result continuation.',
  },
] as const satisfies readonly DeepSpaceAIModel[]

export const DEEPSPACE_AI_DEFAULTS = {
  agent: 'claude-sonnet-5',
  directGeneration: 'claude-sonnet-5',
  summarization: 'claude-haiku-4-5',
} as const satisfies Record<string, DeepSpaceAIModelId>

export const DEEPSPACE_AGENT_PROFILES = {
  application: {
    id: 'application',
    defaultModel: DEEPSPACE_AI_DEFAULTS.agent,
    maxSteps: 21,
    maxToolCalls: 20,
    allowedTools: 'application-defined',
  },
  documentation: {
    id: 'documentation',
    defaultModel: DEEPSPACE_AI_DEFAULTS.agent,
    // Permit up to twenty completed read-only tools plus one final synthesis
    // step. The runner disables tools once the tool-call budget is exhausted.
    maxSteps: 21,
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
  return DEEPSPACE_AI_MODELS.filter((model) =>
    (model.agentProfiles as readonly DeepSpaceAgentProfileId[]).includes(profileId),
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
