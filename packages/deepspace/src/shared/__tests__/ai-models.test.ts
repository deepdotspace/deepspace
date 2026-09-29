import { describe, expect, it } from 'vitest'
import {
  DEEPSPACE_AGENT_PROFILES,
  DEEPSPACE_AI_DEFAULTS,
  DEEPSPACE_AI_MODELS,
  DEEPSPACE_MODEL_CATALOG_PROVENANCE,
  getDeepSpaceAIModel,
  listDeepSpaceAgentModels,
  resolveDeepSpaceAgentModel,
  type DeepSpaceAIModel,
} from '../ai-models'

describe('canonical DeepSpace model catalog', () => {
  it('contains unique current model ids with auditable provider provenance', () => {
    const ids = DEEPSPACE_AI_MODELS.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    const current = DEEPSPACE_AI_MODELS.filter((model: DeepSpaceAIModel) => !model.legacy).map((model) => model.id)
    expect(current).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-6-astra',
      'gpt-oss-120b',
      'qwen-3.8-27b',
    ])
    expect(DEEPSPACE_MODEL_CATALOG_PROVENANCE.version).toBe('2026-09-24')
    expect(Object.values(DEEPSPACE_MODEL_CATALOG_PROVENANCE.sources)
      .every((source) => source.startsWith('https://'))).toBe(true)
  })

  it('defaults agents and direct generation to Claude Opus 5.5', () => {
    expect(DEEPSPACE_AI_DEFAULTS.agent).toBe('claude-opus-5-5')
    expect(DEEPSPACE_AI_DEFAULTS.directGeneration).toBe('claude-opus-5-5')
  })

  it('keeps superseded models resolvable but out of pickers', () => {
    const listed = listDeepSpaceAgentModels('application').map((model) => model.id)
    for (const id of ['claude-opus-5', 'claude-fable-5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getDeepSpaceAIModel(id)?.legacy).toBe(true)
      expect(resolveDeepSpaceAgentModel(id, 'application')?.modelId).toBe(id)
      expect(listed).not.toContain(id)
    }
  })

  it('keeps GPT-6 Astra out of the agent loop (its tools need the Responses API)', () => {
    expect(getDeepSpaceAIModel('gpt-6-astra')?.agentSupport).toBe('none')
    expect(resolveDeepSpaceAgentModel('gpt-6-astra', 'application')).toBeNull()
  })

  it('uses the same compatible selection for application and docs agents', () => {
    for (const profile of ['application', 'documentation'] as const) {
      const models = listDeepSpaceAgentModels(profile)
      expect(models.length).toBeGreaterThan(0)
      expect(models[0]?.id).toBe(DEEPSPACE_AGENT_PROFILES[profile].defaultModel)
      expect(models.every((model) => model.agentSupport === 'multi-step')).toBe(true)
      expect(resolveDeepSpaceAgentModel(undefined, profile)?.modelId)
        .toBe(DEEPSPACE_AGENT_PROFILES[profile].defaultModel)
    }
    expect(DEEPSPACE_AGENT_PROFILES.documentation.allowedTools)
      .toEqual(['documentation_search', 'documentation_read'])
    expect(DEEPSPACE_AGENT_PROFILES.documentation.maxToolCalls).toBe(20)
    expect(DEEPSPACE_AGENT_PROFILES.documentation.maxSteps).toBe(21)
    expect(DEEPSPACE_AGENT_PROFILES.application.maxToolCalls).toBe(20)
    expect(DEEPSPACE_AGENT_PROFILES.application.maxSteps).toBe(21)
  })

  it.each(['gpt-oss-120b', 'qwen-3.8-27b'])('keeps direct-generation model %s out of multi-step agent profiles', (id) => {
    expect(getDeepSpaceAIModel(id)?.agentSupport).toBe('single-step')
    expect(resolveDeepSpaceAgentModel(id, 'application')).toBeNull()
    expect(resolveDeepSpaceAgentModel(id, 'documentation')).toBeNull()
  })
})
