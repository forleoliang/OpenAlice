/**
 * AI Provider Presets — constraint-based templates for profile creation.
 *
 * Each preset defines which fields are locked (not user-editable),
 * hidden (not shown in UI), required (must be filled), and what
 * models are available to choose from.
 *
 * Presets are NOT profiles — they are templates that guide profile
 * creation. Users create concrete profiles from presets.
 */

import type { AIBackend } from '../core/config.js'

// ==================== Types ====================

export interface PresetModelOption {
  /** Model ID as sent to the API (e.g. 'claude-sonnet-4-6'). */
  id: string
  /** Human-readable label (e.g. 'Claude Sonnet 4.6'). */
  label: string
}

export interface PresetField<T = string> {
  /** The preset value for this field. */
  value: T
  /** If true, user cannot edit this field — it's baked into the preset. */
  locked: boolean
  /** If true, field is not displayed in the UI (but its value is still used). */
  hidden?: boolean
  /** If true, user must provide a value for this field (e.g. API key). */
  required?: boolean
}

export interface Preset {
  id: string
  label: string
  description: string
  category: 'official' | 'third-party' | 'custom'

  // Field constraints (undefined = field not applicable to this preset)
  backend: PresetField<AIBackend>
  loginMethod?: PresetField
  provider?: PresetField
  baseUrl?: PresetField
  apiKey?: PresetField

  // Model selection
  models: PresetModelOption[]
  /** Default model ID to pre-select. */
  defaultModel?: string
  /** If true, model can be left empty (OAuth mode — server picks based on plan). */
  modelOptional?: boolean
}

// ==================== Built-in Presets ====================

export const BUILTIN_PRESETS: Preset[] = [
  // ── Official: Claude ──
  {
    id: 'claude-oauth',
    label: 'Claude (Subscription)',
    description: 'Use your Claude Pro/Max subscription',
    category: 'official',
    backend: { value: 'agent-sdk', locked: true, hidden: true },
    loginMethod: { value: 'claudeai', locked: true, hidden: true },
    apiKey: { value: '', locked: true, hidden: true },
    models: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ],
    modelOptional: true,
  },
  {
    id: 'claude-api',
    label: 'Claude (API Key)',
    description: 'Pay per token via Anthropic API',
    category: 'official',
    backend: { value: 'agent-sdk', locked: true, hidden: true },
    loginMethod: { value: 'api-key', locked: true, hidden: true },
    apiKey: { value: '', locked: false, required: true },
    models: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    defaultModel: 'claude-sonnet-4-6',
  },

  // ── Official: OpenAI / Codex ──
  {
    id: 'codex-oauth',
    label: 'OpenAI / Codex (Subscription)',
    description: 'Use your ChatGPT subscription',
    category: 'official',
    backend: { value: 'codex', locked: true, hidden: true },
    loginMethod: { value: 'codex-oauth', locked: true, hidden: true },
    apiKey: { value: '', locked: true, hidden: true },
    models: [
      { id: 'gpt-5.4', label: 'GPT 5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
    ],
    modelOptional: true,
    defaultModel: 'gpt-5.4',
  },
  {
    id: 'codex-api',
    label: 'OpenAI (API Key)',
    description: 'Pay per token via OpenAI API',
    category: 'official',
    backend: { value: 'codex', locked: true, hidden: true },
    loginMethod: { value: 'api-key', locked: true, hidden: true },
    apiKey: { value: '', locked: false, required: true },
    models: [
      { id: 'gpt-5.4', label: 'GPT 5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
    ],
    defaultModel: 'gpt-5.4',
  },

  // ── Official: Gemini ──
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Google AI via API key',
    category: 'official',
    backend: { value: 'vercel-ai-sdk', locked: true, hidden: true },
    provider: { value: 'google', locked: true, hidden: true },
    apiKey: { value: '', locked: false, required: true },
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    defaultModel: 'gemini-2.5-flash',
  },

  // ── Third-party: MiniMax ──
  {
    id: 'minimax',
    label: 'MiniMax',
    description: 'MiniMax models via Anthropic-compatible API',
    category: 'third-party',
    backend: { value: 'vercel-ai-sdk', locked: true, hidden: true },
    provider: { value: 'anthropic', locked: true, hidden: true },
    baseUrl: { value: 'https://api.minimaxi.com/anthropic', locked: true },
    apiKey: { value: '', locked: false, required: true },
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
    ],
    defaultModel: 'MiniMax-M2.7',
  },

  // ── Custom ──
  {
    id: 'custom',
    label: 'Custom',
    description: 'Full control — any provider, model, and endpoint',
    category: 'custom',
    backend: { value: 'vercel-ai-sdk', locked: false },
    provider: { value: 'openai', locked: false },
    loginMethod: { value: 'api-key', locked: false },
    baseUrl: { value: '', locked: false },
    apiKey: { value: '', locked: false },
    models: [],
  },
]
