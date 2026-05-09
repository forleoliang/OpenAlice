/**
 * 0001_initial_unified — roll-up of pre-framework ad-hoc migrations.
 *
 * Body is the four migration ifblocks that previously lived inline in
 * config.ts:loadConfig(), copied here verbatim and adapted to use
 * MigrationContext for IO. Each ifblock is its own structural-detection
 * guard that short-circuits when its precondition isn't met, so the
 * combined body is naturally idempotent against already-current data.
 *
 * Covers:
 *   - very-old format (no backend, no profiles) → profile-based
 *   - flat ai-provider config → profile-based
 *   - claude-code → agent-sdk alias rename
 *   - subchannel inline overrides → named profiles
 *   - global apiKeys → distributed into per-profile apiKey
 *   - telegram.json + engine port fields → connectors.json
 *
 * Rationale for not splitting into 5 named migrations: their upstream
 * boundaries are lost. Different historical user installs took
 * different paths through these blocks; no journal of "which user
 * came through which transition" exists. Splitting would translate
 * ambiguity into false precision.
 */

import type { Migration, MigrationContext } from '../types.js'

export const migration: Migration = {
  id: '0001_initial_unified',
  appVersion: '0.10.0-beta.1',
  introducedAt: '2026-05-09',
  affects: ['*'],
  summary:
    'Roll-up of pre-framework ad-hoc migrations: model.json/api-keys.json merge, claude-code alias, flat → profile-based, subchannel overrides → named profiles, apiKeys distribution, telegram + engine port consolidation',
  up: async (ctx) => {
    await migrateAIProviderShape(ctx)
    await distributeApiKeys(ctx)
    await consolidateConnectorsConfig(ctx)
  },
}

// ==================== Block 1+2: ai-provider shape migration ====================

async function migrateAIProviderShape(ctx: MigrationContext): Promise<void> {
  const aiProviderRaw = await ctx.readJson<Record<string, unknown>>('ai-provider-manager.json')

  // Block 1: flat ai-provider config → profile-based
  if (aiProviderRaw && 'backend' in aiProviderRaw && !('profiles' in aiProviderRaw)) {
    // Step 1: handle very old format (model.json + api-keys.json)
    if (!('model' in aiProviderRaw)) {
      const oldModel = await ctx.readJson<Record<string, unknown>>('model.json')
      const oldKeys = await ctx.readJson<Record<string, unknown>>('api-keys.json')
      if (oldModel) {
        Object.assign(aiProviderRaw, {
          provider: oldModel.provider,
          model: oldModel.model,
          ...(oldModel.baseUrl ? { baseUrl: oldModel.baseUrl } : {}),
        })
      }
      if (oldKeys) aiProviderRaw.apiKeys = oldKeys
      await ctx.removeJson('model.json')
      await ctx.removeJson('api-keys.json')
    }

    // Step 2: claude-code → agent-sdk alias
    if (aiProviderRaw.backend === 'claude-code') {
      aiProviderRaw.backend = 'agent-sdk'
      aiProviderRaw.loginMethod = aiProviderRaw.loginMethod ?? 'claudeai'
    }

    // Step 3: build default profile from flat config
    const backend = aiProviderRaw.backend as string
    const defaultProfile: Record<string, unknown> = { label: 'Default' }
    if (backend === 'agent-sdk') {
      defaultProfile.backend = 'agent-sdk'
      defaultProfile.model = aiProviderRaw.model
      defaultProfile.loginMethod =
        aiProviderRaw.loginMethod === 'codex-oauth'
          ? 'api-key'
          : aiProviderRaw.loginMethod ?? 'api-key'
    } else if (backend === 'codex') {
      defaultProfile.backend = 'codex'
      defaultProfile.model = aiProviderRaw.model
      defaultProfile.loginMethod =
        aiProviderRaw.loginMethod === 'claudeai'
          ? 'codex-oauth'
          : aiProviderRaw.loginMethod ?? 'codex-oauth'
    } else {
      defaultProfile.backend = 'vercel-ai-sdk'
      defaultProfile.provider = aiProviderRaw.provider ?? 'anthropic'
      defaultProfile.model = aiProviderRaw.model
    }
    if (aiProviderRaw.baseUrl) defaultProfile.baseUrl = aiProviderRaw.baseUrl

    // Step 4: subchannel inline overrides → named profiles
    const oldSubchannels = await ctx.readJson<Array<Record<string, unknown>>>('web-subchannels.json')
    const profiles: Record<string, unknown> = { default: defaultProfile }
    const newSubchannels: Array<Record<string, unknown>> = []

    if (oldSubchannels) {
      for (const ch of oldSubchannels) {
        const sub: Record<string, unknown> = { id: ch.id, label: ch.label }
        if (ch.systemPrompt) sub.systemPrompt = ch.systemPrompt
        if (ch.disabledTools) sub.disabledTools = ch.disabledTools

        const provider = ch.provider as string | undefined
        const override =
          provider === 'vercel-ai-sdk' ? ch.vercelAiSdk
          : provider === 'agent-sdk' ? ch.agentSdk
          : provider === 'codex' ? ch.codex
          : undefined

        if (provider && override) {
          const slug = `${ch.id}-${provider}`
          profiles[slug] = { backend: provider, label: `${ch.label}`, ...(override as object) }
          sub.profile = slug
        } else if (provider) {
          const slug = `${ch.id}-${provider}`
          profiles[slug] = { ...defaultProfile, backend: provider, label: `${ch.label}` }
          sub.profile = slug
        }

        newSubchannels.push(sub)
      }
      await ctx.writeJson('web-subchannels.json', newSubchannels)
    }

    // Step 5: write new format
    const apiKeys = (aiProviderRaw.apiKeys as Record<string, unknown>) ?? {}
    await ctx.writeJson('ai-provider-manager.json', {
      apiKeys,
      profiles,
      activeProfile: 'default',
    })
    return
  }

  // Block 2: very-old format (no backend, no profiles) — only when the file exists at all
  if (aiProviderRaw && !('backend' in aiProviderRaw) && !('profiles' in aiProviderRaw)) {
    const oldModel = await ctx.readJson<Record<string, unknown>>('model.json')
    const oldKeys = await ctx.readJson<Record<string, unknown>>('api-keys.json')
    const migrated = {
      apiKeys: oldKeys ?? {},
      profiles: {
        default: {
          backend: 'agent-sdk',
          label: 'Default',
          model: (oldModel?.model as string) ?? 'claude-opus-4-7',
          loginMethod: 'claudeai',
          provider: (oldModel?.provider as string) ?? 'anthropic',
        },
      },
      activeProfile: 'default',
    }
    await ctx.writeJson('ai-provider-manager.json', migrated)
    await ctx.removeJson('model.json')
    await ctx.removeJson('api-keys.json')
  }
}

// ==================== Block 3: distribute global apiKeys into profiles ====================

async function distributeApiKeys(ctx: MigrationContext): Promise<void> {
  const aiConfig = await ctx.readJson<Record<string, unknown>>('ai-provider-manager.json')
  if (!aiConfig || !('apiKeys' in aiConfig) || !('profiles' in aiConfig)) return

  const keys = aiConfig.apiKeys as Record<string, string> | undefined
  const profiles = aiConfig.profiles as Record<string, Record<string, unknown>>

  if (!keys || !Object.values(keys).some(Boolean)) return

  let changed = false
  for (const profile of Object.values(profiles)) {
    if (profile.apiKey) continue // already has a key, don't overwrite
    const vendor =
      profile.backend === 'codex' ? 'openai'
      : profile.backend === 'agent-sdk' ? 'anthropic'
      : (profile.provider as string) ?? 'anthropic'
    const globalKey = keys[vendor]
    if (globalKey) {
      profile.apiKey = globalKey
      changed = true
    }
  }

  if (changed) {
    delete aiConfig.apiKeys
    await ctx.writeJson('ai-provider-manager.json', aiConfig)
  }
}

// ==================== Block 4: consolidate telegram.json + engine port fields ====================

async function consolidateConnectorsConfig(ctx: MigrationContext): Promise<void> {
  const connectorsRaw = await ctx.readJson<Record<string, unknown>>('connectors.json')
  if (connectorsRaw !== undefined) return // already migrated or not applicable

  const oldTelegram = await ctx.readJson<Record<string, unknown>>('telegram.json')
  const oldEngine = await ctx.readJson<Record<string, unknown>>('engine.json')
  const migrated: Record<string, unknown> = {}

  if (oldTelegram && typeof oldTelegram === 'object') {
    migrated.telegram = { ...oldTelegram, enabled: true }
  }
  if (oldEngine) {
    if (oldEngine.webPort !== undefined) migrated.web = { port: oldEngine.webPort }
    if (oldEngine.mcpPort !== undefined) migrated.mcp = { port: oldEngine.mcpPort }
    if (oldEngine.askMcpPort !== undefined) migrated.mcpAsk = { enabled: true, port: oldEngine.askMcpPort }
    const { mcpPort: _m, askMcpPort: _a, webPort: _w, ...cleanEngine } = oldEngine
    void _m; void _a; void _w
    await ctx.writeJson('engine.json', cleanEngine)
  }

  if (Object.keys(migrated).length > 0) {
    await ctx.writeJson('connectors.json', migrated)
  }
}
