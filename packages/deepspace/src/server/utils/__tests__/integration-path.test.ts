import { describe, expect, it } from 'vitest'
import { integrationPath, splitIntegrationEndpoint } from '../integration-path'

describe('integrationPath', () => {
  it('builds the api-worker path for plain identifiers', () => {
    expect(integrationPath('openai', 'chat-completion')).toBe(
      '/api/integrations/openai/chat-completion',
    )
  })

  it('refuses anything that could leave the integration route', () => {
    for (const [name, endpoint] of [
      ['..', 'users'],
      ['../../api/users', 'me'],
      ['openai', '..\\..\\api'],
      ['openai', 'a/b'],
      ['openai', 'a%2Fb'],
      ['openai', 'chat?x=1'],
      ['', 'x'],
    ]) {
      expect(integrationPath(name, endpoint)).toBeNull()
    }
  })
})

describe('splitIntegrationEndpoint', () => {
  it('splits "name/endpoint"', () => {
    expect(splitIntegrationEndpoint('fal/run-model')).toEqual({
      name: 'fal',
      endpoint: 'run-model',
      path: '/api/integrations/fal/run-model',
    })
  })

  it('refuses one part, three parts, or traversal', () => {
    for (const value of ['fal', 'fal/run/x', '../users/me', 'fal/', '/fal']) {
      expect(splitIntegrationEndpoint(value)).toBeNull()
    }
  })
})
