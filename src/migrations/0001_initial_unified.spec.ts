import { describe, it, expect } from 'vitest'
import type { MigrationContext } from './types.js'
import { migration } from './0001_initial_unified/index.js'

function makeMemoryContext(initial: Record<string, unknown> = {}): {
  ctx: MigrationContext
  files: Map<string, unknown>
} {
  const files = new Map<string, unknown>(Object.entries(initial))
  const ctx: MigrationContext = {
    async readJson<T>(filename: string): Promise<T | undefined> {
      const v = files.get(filename)
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
    },
    async writeJson(filename: string, data: unknown): Promise<void> {
      files.set(filename, JSON.parse(JSON.stringify(data)))
    },
    async removeJson(filename: string): Promise<void> {
      files.delete(filename)
    },
    configDir(): string {
      return '/virtual/config'
    },
  }
  return { ctx, files }
}

describe('0001_initial_unified', () => {
  it('fresh install (no config) — no-op, leaves no files', async () => {
    const { ctx, files } = makeMemoryContext()
    await migration.up(ctx)
    expect(files.size).toBe(0)
  })

  it('already-current data (profile-based, no apiKeys, with connectors) — no-op', async () => {
    const initial = {
      'ai-provider-manager.json': {
        profiles: {
          default: { backend: 'agent-sdk', model: 'claude-opus-4-7', loginMethod: 'claudeai' },
        },
        activeProfile: 'default',
      },
      'connectors.json': { web: { port: 3002 } },
    }
    const { ctx, files } = makeMemoryContext(initial)
    const before = JSON.stringify([...files.entries()])
    await migration.up(ctx)
    const after = JSON.stringify([...files.entries()])
    expect(after).toBe(before)
  })

  it('migrates flat ai-provider config → profile-based', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        backend: 'agent-sdk',
        model: 'claude-opus-4-7',
        loginMethod: 'claudeai',
        provider: 'anthropic',
      },
    })

    await migration.up(ctx)

    const after = files.get('ai-provider-manager.json') as Record<string, unknown>
    expect(after.activeProfile).toBe('default')
    expect(after.profiles).toBeDefined()
    const profiles = after.profiles as Record<string, Record<string, unknown>>
    expect(profiles.default.backend).toBe('agent-sdk')
    expect(profiles.default.loginMethod).toBe('claudeai')
    expect(profiles.default.model).toBe('claude-opus-4-7')
  })

  it('renames claude-code → agent-sdk during flat migration', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        backend: 'claude-code',
        model: 'claude-opus-4-7',
      },
    })

    await migration.up(ctx)

    const after = files.get('ai-provider-manager.json') as Record<string, unknown>
    const profiles = after.profiles as Record<string, Record<string, unknown>>
    expect(profiles.default.backend).toBe('agent-sdk')
    expect(profiles.default.loginMethod).toBe('claudeai')
  })

  it('distributes global apiKeys into profiles', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        apiKeys: { anthropic: 'sk-ant', openai: 'sk-oa' },
        profiles: {
          a: { backend: 'agent-sdk', model: 'claude-opus-4-7', loginMethod: 'api-key' },
          b: { backend: 'codex', model: 'gpt-5.4', loginMethod: 'api-key' },
        },
        activeProfile: 'a',
      },
    })

    await migration.up(ctx)

    const after = files.get('ai-provider-manager.json') as Record<string, unknown>
    const profiles = after.profiles as Record<string, Record<string, unknown>>
    expect(profiles.a.apiKey).toBe('sk-ant')
    expect(profiles.b.apiKey).toBe('sk-oa')
    expect(after.apiKeys).toBeUndefined() // removed after distribution
  })

  it('does NOT overwrite profile.apiKey when one already exists', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        apiKeys: { anthropic: 'sk-ant' },
        profiles: {
          a: { backend: 'agent-sdk', model: 'm', loginMethod: 'api-key', apiKey: 'sk-existing' },
        },
        activeProfile: 'a',
      },
    })

    await migration.up(ctx)

    const after = files.get('ai-provider-manager.json') as Record<string, unknown>
    const profiles = after.profiles as Record<string, Record<string, unknown>>
    expect(profiles.a.apiKey).toBe('sk-existing')
  })

  it('consolidates telegram.json + engine port fields → connectors.json', async () => {
    const { ctx, files } = makeMemoryContext({
      'telegram.json': { botToken: 'tg-token' },
      'engine.json': { pairs: ['BTC/USD'], webPort: 3010, mcpPort: 3011 },
    })

    await migration.up(ctx)

    const connectors = files.get('connectors.json') as Record<string, Record<string, unknown>>
    expect(connectors.telegram).toEqual({ botToken: 'tg-token', enabled: true })
    expect(connectors.web).toEqual({ port: 3010 })
    expect(connectors.mcp).toEqual({ port: 3011 })

    const engine = files.get('engine.json') as Record<string, unknown>
    expect(engine.webPort).toBeUndefined()
    expect(engine.mcpPort).toBeUndefined()
    expect(engine.pairs).toEqual(['BTC/USD'])
  })

  it('skips connectors consolidation when connectors.json already exists', async () => {
    const { ctx, files } = makeMemoryContext({
      'telegram.json': { botToken: 'tg-token' },
      'connectors.json': { web: { port: 9999 } }, // already migrated
    })

    await migration.up(ctx)

    const connectors = files.get('connectors.json') as Record<string, Record<string, unknown>>
    expect(connectors.web).toEqual({ port: 9999 }) // unchanged
    expect(connectors.telegram).toBeUndefined()
  })

  it('idempotent: second run produces same state', async () => {
    const initial = {
      'ai-provider-manager.json': {
        backend: 'agent-sdk',
        model: 'claude-opus-4-7',
        loginMethod: 'claudeai',
        apiKeys: { anthropic: 'sk-ant' },
      },
    }
    const { ctx, files } = makeMemoryContext(initial)

    await migration.up(ctx)
    const afterFirst = JSON.stringify([...files.entries()])
    await migration.up(ctx)
    const afterSecond = JSON.stringify([...files.entries()])

    expect(afterSecond).toBe(afterFirst)
  })
})
