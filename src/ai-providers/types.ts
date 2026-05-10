import type { ISessionStore, SessionEntry } from '../core/session.js'
import type { CompactionConfig, CompactionResult } from '../core/compaction.js'
import type { MediaAttachment } from '../core/types.js'
import type { ResolvedProfile } from '../core/config.js'

// ==================== Provider Events ====================

/** Streaming event emitted by AI providers during generation. */
export type ProviderEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ProviderResult }

// ==================== Types ====================

/** A tool the AI invoked during this generation. Captured by AgentCenter
 *  as `tool_use` events stream through the pipeline. Used by AgentWork's
 *  outputGate to detect intent-signal tools like `notify_user`. */
export interface ToolCallSummary {
  id: string
  name: string
  input: unknown
}

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
  mediaUrls?: string[]
  /** Tool calls observed during this generation, in invocation order.
   *  AgentCenter populates this when it synthesizes the final done event;
   *  individual providers don't need to fill it themselves. */
  toolCalls?: ReadonlyArray<ToolCallSummary>
}

// ==================== GenerateOpts ====================

/** Per-request options passed through to the underlying provider. */
export interface GenerateOpts {
  /** System prompt override for this call. */
  systemPrompt?: string
  /** Preamble text for chat history (text providers only). */
  historyPreamble?: string
  /** Max history entries to include (text providers only). */
  maxHistoryEntries?: number
  disabledTools?: string[]
  /** Resolved profile — contains model, apiKey, baseUrl, etc. */
  profile?: ResolvedProfile
}

// ==================== AIProvider ====================

/**
 * Slim provider interface — pure data-source adapter.
 *
 * Receives raw session entries + current prompt. Each provider decides
 * how to serialize history for its backend (text string, structured messages, etc.).
 */
export interface AIProvider {
  /** Session log provenance tag. */
  readonly providerTag: 'vercel-ai' | 'claude-code' | 'agent-sdk' | 'codex'
  /** Stateless one-shot prompt. Profile controls auth/model/endpoint. */
  ask(prompt: string, profile?: ResolvedProfile): Promise<ProviderResult>
  /** Stream events from the backend. Yields tool_use/tool_result/text, then done. */
  generate(entries: SessionEntry[], prompt: string, opts?: GenerateOpts): AsyncIterable<ProviderEvent>
  /**
   * Optional: custom compaction strategy. If implemented, AgentCenter delegates
   * compaction to the provider instead of using the default compactIfNeeded.
   */
  compact?(session: ISessionStore, config: CompactionConfig): Promise<CompactionResult>
}
