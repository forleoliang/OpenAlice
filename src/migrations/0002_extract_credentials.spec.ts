import { describe, it, expect } from 'vitest'
import type { MigrationContext } from './types.js'
import { migration } from './0002_extract_credentials/index.js'

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

function setup(profiles: Record<string, Record<string, unknown>>) {
  return makeMemoryContext({
    'ai-provider-manager.json': {
      profiles,
      activeProfile: Object.keys(profiles)[0] ?? 'default',
    },
  })
}

function getCfg(files: Map<string, unknown>) {
  return files.get('ai-provider-manager.json') as {
    profiles: Record<string, Record<string, unknown>>
    credentials?: Record<string, { vendor: string; authType: string; apiKey?: string; baseUrl?: string }>
  }
}

describe('0002_extract_credentials — vendor inference', () => {
  it('codex + codex-oauth → openai/subscription', async () => {
    const { ctx, files } = setup({
      a: { backend: 'codex', loginMethod: 'codex-oauth', model: 'gpt-5.4' },
    })
    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.profiles.a.credentialSlug).toBe('openai-1')
    expect(cfg.credentials!['openai-1']).toEqual({ vendor: 'openai', authType: 'subscription' })
  })

  it('codex + api-key → openai/api-key', async () => {
    const { ctx, files } = setup({
      a: { backend: 'codex', loginMethod: 'api-key', model: 'gpt-5.4', apiKey: 'sk-oa' },
    })
    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.credentials!['openai-1']).toEqual({ vendor: 'openai', authType: 'api-key', apiKey: 'sk-oa' })
  })

  it('agent-sdk + claudeai → anthropic/subscription', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'claudeai', model: 'claude-opus-4-7' },
    })
    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.credentials!['anthropic-1']).toEqual({ vendor: 'anthropic', authType: 'subscription' })
  })

  it('agent-sdk + api-key + GLM baseUrl → glm', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'glm-4.7', apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    })
    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.credentials!['glm-1'].vendor).toBe('glm')
    expect(cfg.credentials!['glm-1'].baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
  })

  it('agent-sdk + MiniMax baseUrl → minimax', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'M', apiKey: 'k', baseUrl: 'https://api.minimaxi.com/anthropic' },
    })
    await migration.up(ctx)
    expect(getCfg(files).credentials!['minimax-1'].vendor).toBe('minimax')
  })

  it('agent-sdk + Kimi baseUrl → kimi', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'k', apiKey: 'k', baseUrl: 'https://api.moonshot.cn/anthropic' },
    })
    await migration.up(ctx)
    expect(getCfg(files).credentials!['kimi-1'].vendor).toBe('kimi')
  })

  it('agent-sdk + DeepSeek baseUrl → deepseek', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'd', apiKey: 'k', baseUrl: 'https://api.deepseek.com/anthropic' },
    })
    await migration.up(ctx)
    expect(getCfg(files).credentials!['deepseek-1'].vendor).toBe('deepseek')
  })

  it('agent-sdk + api-key + no recognized baseUrl → anthropic', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'm', apiKey: 'k' },
    })
    await migration.up(ctx)
    expect(getCfg(files).credentials!['anthropic-1'].vendor).toBe('anthropic')
  })

  it('vercel-ai-sdk uses profile.provider', async () => {
    const { ctx, files } = setup({
      a: { backend: 'vercel-ai-sdk', provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' },
    })
    await migration.up(ctx)
    expect(getCfg(files).credentials!['google-1'].vendor).toBe('google')
  })
})

describe('0002_extract_credentials — slug + state', () => {
  it('preserves inline apiKey/baseUrl/loginMethod on profile (transitional)', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'm', apiKey: 'sk', baseUrl: 'https://api.example/' },
    })
    await migration.up(ctx)
    const profile = getCfg(files).profiles.a
    expect(profile.apiKey).toBe('sk')
    expect(profile.baseUrl).toBe('https://api.example/')
    expect(profile.loginMethod).toBe('api-key')
    expect(profile.credentialSlug).toBe('anthropic-1')
  })

  it('skips profiles with no extractable credential', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'm' }, // no apiKey, no subscription
    })
    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.profiles.a.credentialSlug).toBeUndefined()
    // credentials field gets initialized to {} on first run
    expect(cfg.credentials).toEqual({})
  })

  it('generates unique slugs across multiple profiles of same vendor', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'm', apiKey: 'k1' },
      b: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'm', apiKey: 'k2' },
      c: { backend: 'agent-sdk', loginMethod: 'claudeai', model: 'm' },
    })
    await migration.up(ctx)
    const cfg = getCfg(files)
    const slugs = Object.values(cfg.profiles).map(p => p.credentialSlug)
    expect(new Set(slugs).size).toBe(3) // all distinct
    expect(slugs.every(s => typeof s === 'string' && s.startsWith('anthropic-'))).toBe(true)
  })

  it('idempotent — second run is a no-op', async () => {
    const { ctx, files } = setup({
      a: { backend: 'agent-sdk', loginMethod: 'api-key', model: 'm', apiKey: 'k' },
    })

    await migration.up(ctx)
    const afterFirst = JSON.stringify(files.get('ai-provider-manager.json'))
    await migration.up(ctx)
    const afterSecond = JSON.stringify(files.get('ai-provider-manager.json'))

    expect(afterSecond).toBe(afterFirst)
  })

  it('no-op when ai-provider-manager.json absent', async () => {
    const { ctx, files } = makeMemoryContext()
    await migration.up(ctx)
    expect(files.size).toBe(0)
  })
})
