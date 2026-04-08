import { useState, useEffect, useRef } from 'react'
import { api, type Profile, type AIBackend, type Preset } from '../api'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Field, inputClass } from '../components/form'
import type { SaveStatus } from '../hooks/useAutoSave'
import { PageHeader } from '../components/PageHeader'
import { PageLoading } from '../components/StateViews'

// ==================== Constants ====================

const BACKEND_ICONS: Record<AIBackend, React.ReactNode> = {
  'agent-sdk': <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V6a4 4 0 0 1 4-4z" /><path d="M8 8v2a4 4 0 0 0 8 0V8" /><path d="M12 14v4" /><path d="M8 22h8" /><circle cx="9" cy="5.5" r="0.5" fill="currentColor" stroke="none" /><circle cx="15" cy="5.5" r="0.5" fill="currentColor" stroke="none" /></svg>,
  'codex': <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /><line x1="14" y1="4" x2="10" y2="20" /></svg>,
  'vercel-ai-sdk': <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
}

// ==================== Main Page ====================

export function AIProviderPage() {
  const [profiles, setProfiles] = useState<Record<string, Profile> | null>(null)
  const [activeProfile, setActiveProfile] = useState('')
  const [apiKeys, setApiKeys] = useState<{ anthropic?: string; openai?: string; google?: string }>({})
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [creatingPreset, setCreatingPreset] = useState<Preset | null>(null)

  useEffect(() => {
    api.config.getProfiles().then(({ profiles: p, activeProfile: a }) => {
      setProfiles(p)
      setActiveProfile(a)
      setSelectedSlug(a)
    }).catch(() => {})
    api.config.getPresets().then(({ presets: p }) => setPresets(p)).catch(() => {})
    api.config.getApiKeysStatus().then((status) => {
      setApiKeys({
        ...(status.anthropic ? { anthropic: '(set)' } : {}),
        ...(status.openai ? { openai: '(set)' } : {}),
        ...(status.google ? { google: '(set)' } : {}),
      })
    }).catch(() => {})
  }, [])

  const handleSetActive = async (slug: string) => {
    try {
      await api.config.setActiveProfile(slug)
      setActiveProfile(slug)
    } catch {}
  }

  const handleDelete = async (slug: string) => {
    if (!profiles) return
    try {
      await api.config.deleteProfile(slug)
      const updated = { ...profiles }
      delete updated[slug]
      setProfiles(updated)
      if (selectedSlug === slug) setSelectedSlug(activeProfile)
    } catch {}
  }

  const handleCreateSave = async (slug: string, profile: Profile) => {
    await api.config.createProfile(slug, profile)
    setProfiles((p) => p ? { ...p, [slug]: profile } : p)
    setCreatingPreset(null)
    setSelectedSlug(slug)
  }

  const handleProfileUpdate = async (slug: string, profile: Profile) => {
    await api.config.updateProfile(slug, profile)
    setProfiles((p) => p ? { ...p, [slug]: profile } : p)
  }

  if (!profiles) return <div className="flex flex-col flex-1 min-h-0"><PageHeader title="AI Provider" description="Manage AI provider profiles and API keys." /><PageLoading /></div>

  const selectedProfile = selectedSlug ? profiles[selectedSlug] : null
  // Find the preset that matches the selected profile (for constraint-aware editing)
  const selectedPreset = selectedProfile
    ? presets.find(p => p.backend.value === selectedProfile.backend
        && (!p.loginMethod || p.loginMethod.value === selectedProfile.loginMethod)
        && (!p.provider || p.provider.value === selectedProfile.provider))
    : null

  const officialPresets = presets.filter(p => p.category === 'official')
  const thirdPartyPresets = presets.filter(p => p.category === 'third-party')
  const customPreset = presets.find(p => p.category === 'custom')

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="AI Provider" description="Manage AI provider profiles and API keys." />
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-[880px] mx-auto">

          {/* Profile List */}
          <ConfigSection title="Profiles" description="Create multiple configurations and switch between them.">
            <div className="space-y-2">
              {Object.entries(profiles).map(([slug, profile]) => {
                const isActive = slug === activeProfile
                const isSelected = slug === selectedSlug
                return (
                  <button
                    key={slug}
                    onClick={() => { setSelectedSlug(slug); setCreatingPreset(null) }}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'border-accent bg-accent-dim/30'
                        : 'border-border bg-bg hover:bg-bg-tertiary'
                    }`}
                  >
                    <div className={`${isSelected ? 'text-accent' : 'text-text-muted'}`}>{BACKEND_ICONS[profile.backend]}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-[13px] font-medium truncate ${isSelected ? 'text-accent' : 'text-text'}`}>{profile.label}</span>
                        {isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent font-medium">Active</span>}
                      </div>
                      <p className="text-[11px] text-text-muted truncate">{profile.model || '(auto)'}</p>
                    </div>
                  </button>
                )
              })}
            </div>

            {/* New Profile — Preset Cards */}
            <div className="mt-4">
              <p className="text-[12px] font-medium text-text-muted mb-2">New Profile</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {officialPresets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => { setCreatingPreset(preset); setSelectedSlug(null) }}
                    className={`flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all ${
                      creatingPreset?.id === preset.id
                        ? 'border-accent bg-accent-dim/30'
                        : 'border-border bg-bg hover:bg-bg-tertiary'
                    }`}
                  >
                    <div className="text-text-muted">{BACKEND_ICONS[preset.backend.value]}</div>
                    <p className="text-[12px] font-medium text-text">{preset.label}</p>
                    <p className="text-[10px] text-text-muted leading-snug">{preset.description}</p>
                  </button>
                ))}
                {thirdPartyPresets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => { setCreatingPreset(preset); setSelectedSlug(null) }}
                    className={`flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all ${
                      creatingPreset?.id === preset.id
                        ? 'border-accent bg-accent-dim/30'
                        : 'border-border bg-bg hover:bg-bg-tertiary'
                    }`}
                  >
                    <div className="text-text-muted">{BACKEND_ICONS[preset.backend.value]}</div>
                    <p className="text-[12px] font-medium text-text">{preset.label}</p>
                    <p className="text-[10px] text-text-muted leading-snug">{preset.description}</p>
                  </button>
                ))}
                {customPreset && (
                  <button
                    onClick={() => { setCreatingPreset(customPreset); setSelectedSlug(null) }}
                    className={`flex flex-col items-start gap-1 p-3 rounded-lg border border-dashed text-left transition-all ${
                      creatingPreset?.id === 'custom'
                        ? 'border-accent bg-accent-dim/30'
                        : 'border-border bg-bg hover:bg-bg-tertiary'
                    }`}
                  >
                    <p className="text-[12px] font-medium text-text">+ Custom</p>
                    <p className="text-[10px] text-text-muted leading-snug">{customPreset.description}</p>
                  </button>
                )}
              </div>
            </div>
          </ConfigSection>

          {/* Create Form */}
          {creatingPreset && (
            <ConfigSection title={`New: ${creatingPreset.label}`} description={creatingPreset.description}>
              <PresetProfileForm
                preset={creatingPreset}
                onSave={handleCreateSave}
                onCancel={() => setCreatingPreset(null)}
              />
            </ConfigSection>
          )}

          {/* Edit Form */}
          {selectedProfile && selectedSlug && !creatingPreset && (
            <ConfigSection title={selectedProfile.label} description="Edit profile settings.">
              <ProfileEditor
                slug={selectedSlug}
                profile={selectedProfile}
                preset={selectedPreset}
                isActive={selectedSlug === activeProfile}
                onUpdate={(p) => handleProfileUpdate(selectedSlug, p)}
                onSetActive={() => handleSetActive(selectedSlug)}
                onDelete={() => handleDelete(selectedSlug)}
              />
            </ConfigSection>
          )}

          {/* Global API Keys */}
          <ConfigSection title="Global API Keys" description="Shared across all profiles. Per-profile keys take priority.">
            <ApiKeysForm currentStatus={apiKeys} onSaved={setApiKeys} />
          </ConfigSection>

        </div>
      </div>
    </div>
  )
}

// ==================== Preset-driven Profile Form (Create) ====================

function PresetProfileForm({ preset, onSave, onCancel }: {
  preset: Preset
  onSave: (slug: string, profile: Profile) => Promise<void>
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [model, setModel] = useState(preset.defaultModel ?? '')
  const [customModel, setCustomModel] = useState('')
  const [loginMethod, setLoginMethod] = useState(preset.loginMethod?.value ?? '')
  const [provider, setProvider] = useState(preset.provider?.value ?? '')
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl?.value ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const effectiveModel = model === '__custom__' ? customModel : model

  const handleSave = async () => {
    if (!label.trim()) { setError('Label is required'); return }
    if (!preset.modelOptional && !effectiveModel) { setError('Model is required'); return }
    if (preset.apiKey?.required && !apiKey) { setError('API key is required'); return }
    setSaving(true)
    setError('')
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!slug) { setError('Invalid label for slug generation'); setSaving(false); return }
    const profile: Profile = {
      backend: preset.backend.value,
      label: label.trim(),
      model: effectiveModel,
      ...(loginMethod ? { loginMethod } : {}),
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    }
    try {
      await onSave(slug, profile)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Profile Name">
        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`e.g. My ${preset.label}`} />
      </Field>
      <PresetFields
        preset={preset}
        model={model} setModel={setModel} customModel={customModel} setCustomModel={setCustomModel}
        loginMethod={loginMethod} setLoginMethod={setLoginMethod}
        provider={provider} setProvider={setProvider}
        baseUrl={baseUrl} setBaseUrl={setBaseUrl}
        apiKey={apiKey} setApiKey={setApiKey}
      />
      {error && <p className="text-[12px] text-red">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Create Profile'}</button>
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
      </div>
    </div>
  )
}

// ==================== Profile Editor (Edit existing) ====================

function ProfileEditor({ slug, profile, preset, isActive, onUpdate, onSetActive, onDelete }: {
  slug: string
  profile: Profile
  preset: Preset | null | undefined
  isActive: boolean
  onUpdate: (profile: Profile) => Promise<void>
  onSetActive: () => void
  onDelete: () => void
}) {
  const isPresetModel = preset?.models.some(m => m.id === profile.model)
  const [label, setLabel] = useState(profile.label)
  const [model, setModel] = useState(isPresetModel ? profile.model : (profile.model ? '__custom__' : ''))
  const [customModel, setCustomModel] = useState(isPresetModel ? '' : profile.model)
  const [loginMethod, setLoginMethod] = useState(profile.loginMethod ?? '')
  const [provider, setProvider] = useState(profile.provider ?? '')
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<SaveStatus>('idle')
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const isPreset = preset?.models.some(m => m.id === profile.model)
    setLabel(profile.label)
    setModel(isPreset ? profile.model : (profile.model ? '__custom__' : ''))
    setCustomModel(isPreset ? '' : profile.model)
    setLoginMethod(profile.loginMethod ?? '')
    setProvider(profile.provider ?? '')
    setBaseUrl(profile.baseUrl ?? '')
    setApiKey('')
    setStatus('idle')
  }, [slug, profile, preset])

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const effectiveModel = model === '__custom__' ? customModel : model

  const handleSave = async () => {
    setStatus('saving')
    const updated: Profile = {
      backend: profile.backend,
      label: label.trim() || profile.label,
      model: effectiveModel,
      ...(loginMethod ? { loginMethod } : {}),
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : profile.apiKey ? { apiKey: profile.apiKey } : {}),
    }
    try {
      await onUpdate(updated)
      setStatus('saved')
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setStatus('idle'), 2000)
    } catch {
      setStatus('error')
    }
  }

  // Use preset if available, otherwise build a minimal "custom" view
  const editPreset = preset ?? {
    id: 'custom', label: 'Custom', description: '', category: 'custom' as const,
    backend: { value: profile.backend, locked: true, hidden: true },
    loginMethod: profile.loginMethod ? { value: profile.loginMethod, locked: false } : undefined,
    provider: profile.provider ? { value: profile.provider, locked: false } : undefined,
    baseUrl: { value: profile.baseUrl ?? '', locked: false },
    apiKey: { value: '', locked: false },
    models: [],
  }

  return (
    <div className="space-y-3">
      <Field label="Profile Name">
        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <PresetFields
        preset={editPreset}
        model={model} setModel={setModel} customModel={customModel} setCustomModel={setCustomModel}
        loginMethod={loginMethod} setLoginMethod={setLoginMethod}
        provider={provider} setProvider={setProvider}
        baseUrl={baseUrl} setBaseUrl={setBaseUrl}
        apiKey={apiKey} setApiKey={setApiKey}
        existingApiKey={!!profile.apiKey}
      />
      <div className="flex items-center gap-2 pt-1">
        <button onClick={handleSave} className="btn-primary">Save Changes</button>
        <SaveIndicator status={status} onRetry={handleSave} />
        <div className="flex-1" />
        {!isActive && <button onClick={onSetActive} className="text-[12px] text-accent hover:underline">Set as Default</button>}
        {!isActive && <button onClick={onDelete} className="text-[12px] text-red hover:underline">Delete</button>}
      </div>
    </div>
  )
}

// ==================== Preset-aware Fields ====================

function PresetFields({ preset, model, setModel, customModel, setCustomModel, loginMethod, setLoginMethod, provider, setProvider, baseUrl, setBaseUrl, apiKey, setApiKey, existingApiKey }: {
  preset: Preset
  model: string; setModel: (v: string) => void
  customModel: string; setCustomModel: (v: string) => void
  loginMethod: string; setLoginMethod: (v: string) => void
  provider: string; setProvider: (v: string) => void
  baseUrl: string; setBaseUrl: (v: string) => void
  apiKey: string; setApiKey: (v: string) => void
  existingApiKey?: boolean
}) {
  const f = preset

  return (
    <>
      {/* Login Method */}
      {f.loginMethod && !f.loginMethod.hidden && (
        <Field label="Authentication">
          {f.loginMethod.locked ? (
            <p className="text-[13px] text-text-muted">{f.loginMethod.value}</p>
          ) : (
            <select className={inputClass} value={loginMethod} onChange={(e) => setLoginMethod(e.target.value)}>
              <option value="claudeai">Claude Pro/Max (subscription)</option>
              <option value="codex-oauth">ChatGPT Subscription</option>
              <option value="api-key">API Key</option>
            </select>
          )}
        </Field>
      )}

      {/* Provider */}
      {f.provider && !f.provider.hidden && (
        <Field label="SDK Provider">
          {f.provider.locked ? (
            <p className="text-[13px] text-text-muted">{f.provider.value}</p>
          ) : (
            <select className={inputClass} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
            </select>
          )}
        </Field>
      )}

      {/* Model */}
      <Field label={f.modelOptional ? 'Model (optional)' : 'Model'}>
        {f.models.length > 0 ? (
          <>
            <select
              className={inputClass}
              value={model}
              onChange={(e) => { setModel(e.target.value); if (e.target.value !== '__custom__') setCustomModel('') }}
            >
              {f.modelOptional && <option value="">Auto (based on subscription plan)</option>}
              {f.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              <option value="__custom__">Custom...</option>
            </select>
            {model === '__custom__' && (
              <input
                className={`${inputClass} mt-2`}
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="Enter model ID"
              />
            )}
          </>
        ) : (
          <input
            className={inputClass}
            value={customModel || model}
            onChange={(e) => { setModel(e.target.value); setCustomModel(e.target.value) }}
            placeholder={f.modelOptional ? 'Leave empty for auto' : 'e.g. claude-sonnet-4-6, gpt-5.4'}
          />
        )}
      </Field>

      {/* Base URL */}
      {f.baseUrl && !f.baseUrl.hidden && (
        <Field label="Base URL" description={f.baseUrl.locked ? undefined : 'Leave empty for official API. Set for proxies or compatible endpoints.'}>
          {f.baseUrl.locked ? (
            <p className="text-[13px] text-text-muted font-mono">{f.baseUrl.value}</p>
          ) : (
            <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Leave empty for default" />
          )}
        </Field>
      )}

      {/* API Key */}
      {f.apiKey && !f.apiKey.hidden && !f.apiKey.locked && (
        <Field label={f.apiKey.required ? 'API Key (required)' : 'API Key (optional, overrides global)'}>
          <div className="relative">
            <input
              className={inputClass}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={existingApiKey ? '(configured — leave empty to keep)' : 'Enter API key'}
            />
            {existingApiKey && !apiKey && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-green">active</span>
            )}
          </div>
        </Field>
      )}
    </>
  )
}

// ==================== Global API Keys ====================

function ApiKeysForm({ currentStatus, onSaved }: {
  currentStatus: Record<string, string | undefined>
  onSaved: (status: Record<string, string | undefined>) => void
}) {
  const [keys, setKeys] = useState({ anthropic: '', openai: '', google: '' })
  const [status, setStatus] = useState<SaveStatus>('idle')
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const handleSave = async () => {
    setStatus('saving')
    try {
      const toSave: Record<string, string> = {}
      if (keys.anthropic) toSave.anthropic = keys.anthropic
      if (keys.openai) toSave.openai = keys.openai
      if (keys.google) toSave.google = keys.google
      await api.config.updateApiKeys(toSave)
      onSaved({
        ...currentStatus,
        ...(keys.anthropic ? { anthropic: '(set)' } : {}),
        ...(keys.openai ? { openai: '(set)' } : {}),
        ...(keys.google ? { google: '(set)' } : {}),
      })
      setKeys({ anthropic: '', openai: '', google: '' })
      setStatus('saved')
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setStatus('idle'), 2000)
    } catch {
      setStatus('error')
    }
  }

  const fields = [
    { key: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
    { key: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
    { key: 'google', label: 'Google', placeholder: 'AIza...' },
  ] as const

  return (
    <>
      {fields.map((f) => (
        <Field key={f.key} label={`${f.label} API Key`}>
          <div className="relative">
            <input
              className={inputClass}
              type="password"
              value={keys[f.key]}
              onChange={(e) => setKeys((k) => ({ ...k, [f.key]: e.target.value }))}
              placeholder={currentStatus[f.key] ? '(configured)' : f.placeholder}
            />
            {currentStatus[f.key] && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-green">active</span>
            )}
          </div>
        </Field>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={status === 'saving'} className="btn-primary">Save Keys</button>
        <SaveIndicator status={status} onRetry={handleSave} />
      </div>
    </>
  )
}
