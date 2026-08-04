import { describe, expect, it } from 'vitest'
import {
  DEEPSPACE_AGENT_PROFILES,
  DEEPSPACE_AI_MODELS,
  DEEPSPACE_MODEL_CATALOG_PROVENANCE,
  getDeepSpaceAIModel,
  listDeepSpaceAgentModels,
  resolveDeepSpaceAgentModel,
} from '../ai-models'

describe('canonical DeepSpace model catalog', () => {
  it('contains unique current model ids with auditable provider provenance', () => {
    const ids = DEEPSPACE_AI_MODELS.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]))
    expect(ids).not.toContain('claude-opus-4-8')
    expect(DEEPSPACE_MODEL_CATALOG_PROVENANCE.version).toBe('2026-08-03')
    expect(Object.values(DEEPSPACE_MODEL_CATALOG_PROVENANCE.sources)
      .every((source) => source.startsWith('https://'))).toBe(true)
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
      .toEqual(['docs_search', 'docs_read'])
    expect(DEEPSPACE_AGENT_PROFILES.documentation.maxToolCalls).toBe(20)
    expect(DEEPSPACE_AGENT_PROFILES.documentation.maxSteps).toBe(21)
  })

  it('keeps direct-generation models out of multi-step agent profiles', () => {
    expect(getDeepSpaceAIModel('gpt-oss-120b')?.agentSupport).toBe('single-step')
    expect(resolveDeepSpaceAgentModel('gpt-oss-120b', 'application')).toBeNull()
    expect(resolveDeepSpaceAgentModel('gpt-oss-120b', 'documentation')).toBeNull()
  })
})
