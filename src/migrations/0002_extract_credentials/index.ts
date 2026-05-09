/**
 * 0002_extract_credentials — peel credential storage off Profile.
 *
 * Today every Profile carries inline `apiKey` / `baseUrl` /
 * `loginMethod`. This migration adds a top-level `credentials` map
 * keyed by slug, infers a credential record per profile, and links
 * the profile to the credential via `credentialSlug`. Inline fields
 * are LEFT IN PLACE as a transitional fallback so providers don't
 * need to change in this round (resolveProfile() joins the two and
 * returns the same ResolvedProfile shape).
 *
 * Vendor inference rules (see plan for full table):
 *   backend=codex                                          → openai
 *   backend=agent-sdk + loginMethod=claudeai               → anthropic (subscription)
 *   backend=agent-sdk + baseUrl matches GLM/MiniMax/Kimi/DeepSeek → that vendor
 *   backend=agent-sdk + api-key + other                    → anthropic
 *   backend=vercel-ai-sdk                                  → from profile.provider
 *   fallback                                                → custom
 *
 * In-body idempotency: if the credentials map exists and every
 * profile either has credentialSlug or has nothing to extract, no-op.
 */

import type { Migration, MigrationContext } from '../types.js'

interface RawProfile extends Record<string, unknown> {
  backend?: string
  loginMethod?: string
  apiKey?: string
  baseUrl?: string
  provider?: string
  credentialSlug?: string
}

interface CredentialRecord {
  vendor: string
  authType: 'api-key' | 'subscription'
  apiKey?: string
  baseUrl?: string
}

const VENDORS_BY_BASEURL: Array<[RegExp, string]> = [
  [/bigmodel\.cn|z\.ai/i, 'glm'],
  [/minimaxi\.com|minimax\.io/i, 'minimax'],
  [/moonshot\.cn|moonshot\.ai/i, 'kimi'],
  [/deepseek\.com/i, 'deepseek'],
]

function inferVendor(profile: RawProfile): string {
  const backend = profile.backend
  const loginMethod = profile.loginMethod
  const baseUrl = (profile.baseUrl ?? '') as string

  if (backend === 'codex') return 'openai'

  if (backend === 'agent-sdk' && loginMethod === 'claudeai') return 'anthropic'

  if (backend === 'agent-sdk') {
    for (const [pattern, vendor] of VENDORS_BY_BASEURL) {
      if (pattern.test(baseUrl)) return vendor
    }
    return 'anthropic'
  }

  if (backend === 'vercel-ai-sdk') {
    const provider = profile.provider as string | undefined
    if (provider === 'openai' || provider === 'google' || provider === 'anthropic') return provider
    return 'anthropic'
  }

  return 'custom'
}

function inferAuthType(profile: RawProfile): 'api-key' | 'subscription' {
  if (profile.loginMethod === 'claudeai' || profile.loginMethod === 'codex-oauth') {
    return 'subscription'
  }
  return 'api-key'
}

function hasExtractableCredential(profile: RawProfile): boolean {
  if (profile.apiKey) return true
  if (profile.loginMethod === 'claudeai' || profile.loginMethod === 'codex-oauth') return true
  return false
}

function generateSlug(vendor: string, taken: Set<string>): string {
  let n = 1
  while (taken.has(`${vendor}-${n}`)) n++
  return `${vendor}-${n}`
}

export const migration: Migration = {
  id: '0002_extract_credentials',
  appVersion: '0.10.0-beta.1',
  introducedAt: '2026-05-09',
  affects: ['ai-provider-manager.json'],
  summary:
    'Extract apiKey/baseUrl from profiles into top-level credentials map; profiles gain credentialSlug pointer (inline fields kept as fallback)',
  rationale:
    'Decouple credentials (vendor + auth) from SDK choice (backend) and use-case (model). Foundation for vendor-shaped preset catalog and internal SDK routing.',
  up: async (ctx) => {
    const aiConfig = await ctx.readJson<{
      profiles?: Record<string, RawProfile>
      credentials?: Record<string, CredentialRecord>
      activeProfile?: string
      apiKeys?: Record<string, unknown>
    }>('ai-provider-manager.json')

    if (!aiConfig || !aiConfig.profiles) return

    // In-body idempotency check
    const profilesArr = Object.values(aiConfig.profiles)
    if (
      aiConfig.credentials !== undefined &&
      profilesArr.every((p) => p.credentialSlug !== undefined || !hasExtractableCredential(p))
    ) {
      return
    }

    const credentials: Record<string, CredentialRecord> = aiConfig.credentials ?? {}
    const taken = new Set(Object.keys(credentials))
    let changed = false

    for (const profile of profilesArr) {
      if (profile.credentialSlug) continue
      if (!hasExtractableCredential(profile)) continue

      const vendor = inferVendor(profile)
      const authType = inferAuthType(profile)
      const cred: CredentialRecord = { vendor, authType }
      if (profile.apiKey) cred.apiKey = profile.apiKey as string
      if (profile.baseUrl) cred.baseUrl = profile.baseUrl as string

      const slug = generateSlug(vendor, taken)
      taken.add(slug)
      credentials[slug] = cred
      profile.credentialSlug = slug
      changed = true
    }

    if (!changed && aiConfig.credentials !== undefined) return

    aiConfig.credentials = credentials
    await ctx.writeJson('ai-provider-manager.json', aiConfig)
  },
}
