/**
 * Heartbeat — periodic Alice self-check.
 *
 * Today's shape: a trigger source for `agent.work.requested`. Owns
 * the `__heartbeat__` cron job lifecycle, the active-hours config,
 * and the in-memory dedup window. On each tick:
 *
 *   1. Active-hours pre-filter (inputGate equivalent — but enforced
 *      pre-emit so we don't pollute the event log with skip events
 *      when the heartbeat shouldn't have fired in the first place).
 *      Outside hours → emit `agent.work.skip { source: 'heartbeat',
 *      reason: 'outside-active-hours' }` directly via ctx.emit.
 *   2. Otherwise emit `agent.work.requested { source: 'heartbeat',
 *      prompt }`. The agent-work-listener picks it up and runs.
 *   3. The heartbeat-specific outputGate (dedup + notify_user
 *      inspection) lives in the source config registered with
 *      agent-work-listener at startup. The runner-side gate sees
 *      the AI's tool calls and decides deliver vs skip.
 *
 * Heartbeat no longer imports AgentWorkRunner directly. State that
 * heartbeat owns (HeartbeatDedup, active-hours, cron job lifecycle)
 * stays here; AgentWork-pipeline state (session, gates) is registered
 * with the listener.
 */

import type { Listener, ListenerContext } from '../../core/listener.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import { SessionStore } from '../../core/session.js'
import { writeConfigSection } from '../../core/config.js'
import type { CronEngine } from '../cron/engine.js'
import type { AgentWorkListener, AgentWorkSourceConfig } from '../../core/agent-work-listener.js'
import type { AgentWorkResultProbe } from '../../core/agent-work.js'

const HEARTBEAT_EMITS = [
  'agent.work.requested',
  'agent.work.skip',
] as const
type HeartbeatEmits = typeof HEARTBEAT_EMITS

// ==================== Constants ====================

export const HEARTBEAT_JOB_NAME = '__heartbeat__'

// ==================== Config ====================

export interface HeartbeatConfig {
  enabled: boolean
  /** Interval between heartbeats, e.g. "30m", "1h". */
  every: string
  /** Prompt sent to the AI on each heartbeat. */
  prompt: string
  /** Active hours window. Null = always active. */
  activeHours: {
    start: string   // "HH:MM"
    end: string     // "HH:MM"
    timezone: string // IANA timezone or "local"
  } | null
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: false,
  every: '30m',
  prompt: `You're Alice in the heartbeat monitoring loop. The system pings you periodically so you can check on what's happening — markets, watchlists, pending items, anything trade-relevant the user might want surfaced.

If something is genuinely worth flagging — a notable move, a finished analysis, an answer to a question they've been waiting on — call the \`notify_user\` tool with a concise message in the user's language.

If there's nothing worth surfacing, simply respond briefly with what you observed (or with nothing at all). Don't call \`notify_user\` out of politeness; reserve it for genuinely useful pushes — the user gets pinged whenever it fires.

In short:
- silence = nothing pushed
- \`notify_user("...")\` = a push lands in the user's inbox`,
  activeHours: null,
}

// ==================== Types ====================

export interface HeartbeatOpts {
  config: HeartbeatConfig
  /** Where to register the heartbeat source config so the agent-work
   *  pipeline knows how to handle heartbeat-sourced requests. */
  agentWorkListener: AgentWorkListener
  cronEngine: CronEngine
  /** Listener registry for the heartbeat's own cron-fire subscriber. */
  registry: ListenerRegistry
  /** Optional: inject a session for testing. */
  session?: SessionStore
  /** Inject clock for testing. */
  now?: () => number
}

export interface Heartbeat {
  start(): Promise<void>
  stop(): void
  /** Hot-toggle heartbeat on/off (persists to config + updates cron job). */
  setEnabled(enabled: boolean): Promise<void>
  /** Current enabled state. */
  isEnabled(): boolean
  /** Expose the raw listener for direct testing. */
  readonly listener: Listener<'cron.fire', HeartbeatEmits>
}

// ==================== Factory ====================

export function createHeartbeat(opts: HeartbeatOpts): Heartbeat {
  const { config, agentWorkListener, cronEngine, registry } = opts
  const session = opts.session ?? new SessionStore('heartbeat')
  const now = opts.now ?? Date.now

  let jobId: string | null = null
  let processing = false
  let enabled = config.enabled
  let registered = false

  const dedup = new HeartbeatDedup()

  // ---- Source config (registered with agent-work-listener) ----
  //
  // The output-side semantics (notify_user inspection + dedup gate)
  // live here, closing over the dedup instance heartbeat owns. The
  // agent-work-listener calls these when an agent.work.requested
  // event with source='heartbeat' arrives.
  const sourceConfig: AgentWorkSourceConfig = {
    source: 'heartbeat',
    session,
    preamble: () =>
      'You are operating in the heartbeat monitoring context (session: heartbeat). The following is the recent heartbeat conversation history.',
    outputGate: (probe: AgentWorkResultProbe) => {
      const call = probe.toolCalls.find((c) => c.name === 'notify_user')
      if (!call) {
        return { kind: 'skip', reason: 'ack', payload: { reason: 'ack' } }
      }
      const text = ((call.input ?? {}) as { text?: string }).text ?? ''
      if (!text.trim()) {
        return { kind: 'skip', reason: 'empty', payload: { reason: 'empty' } }
      }
      if (dedup.isDuplicate(text, now())) {
        return {
          kind: 'skip',
          reason: 'duplicate',
          payload: { reason: 'duplicate', parsedReason: text.slice(0, 80) },
        }
      }
      return { kind: 'deliver', text, media: probe.media }
    },
    onDelivered: (text) => dedup.record(text, now()),
  }

  const listener: Listener<'cron.fire', HeartbeatEmits> = {
    name: 'heartbeat',
    subscribes: 'cron.fire',
    emits: HEARTBEAT_EMITS,
    async handle(entry, ctx: ListenerContext<HeartbeatEmits>) {
      const payload = entry.payload

      // Filter to our own cron job
      if (payload.jobName !== HEARTBEAT_JOB_NAME) return

      // Serial — preserve today's behaviour. Concurrent heartbeats
      // would race on dedup state.
      if (processing) return

      processing = true
      const startMs = now()
      console.log(`heartbeat: firing at ${new Date(startMs).toISOString()}`)
      try {
        // ---- Pre-emit gate: active-hours ----
        if (!isWithinActiveHours(config.activeHours, now())) {
          await ctx.emit('agent.work.skip', {
            source: 'heartbeat',
            reason: 'outside-active-hours',
          })
          console.log(`heartbeat: skipped (outside-active-hours)`)
          return
        }

        // ---- Emit canonical request ----
        await ctx.emit('agent.work.requested', {
          source: 'heartbeat',
          prompt: payload.payload,
        })
      } finally {
        processing = false
      }
    },
  }

  /** Ensure the cron job exists and the listener + producer are registered (idempotent). */
  async function ensureJobAndListener(): Promise<void> {
    const existing = cronEngine.list().find((j) => j.name === HEARTBEAT_JOB_NAME)
    if (existing) {
      jobId = existing.id
      await cronEngine.update(existing.id, {
        schedule: { kind: 'every', every: config.every },
        payload: config.prompt,
        enabled,
      })
    } else {
      jobId = await cronEngine.add({
        name: HEARTBEAT_JOB_NAME,
        schedule: { kind: 'every', every: config.every },
        payload: config.prompt,
        enabled,
      })
    }

    if (!registered) {
      registry.register(listener)
      agentWorkListener.registerSource(sourceConfig)
      registered = true
    }
  }

  return {
    listener,
    async start() {
      await ensureJobAndListener()
    },
    stop() {
      if (registered) {
        registry.unregister(listener.name)
        registered = false
      }
    },
    async setEnabled(newEnabled: boolean) {
      enabled = newEnabled
      await ensureJobAndListener()
      await writeConfigSection('heartbeat', { ...config, enabled: newEnabled })
    },
    isEnabled() {
      return enabled
    },
  }
}

// ==================== Active Hours ====================

/**
 * Check if the current time falls within the active hours window.
 * Returns true if no activeHours configured (always active).
 */
export function isWithinActiveHours(
  activeHours: HeartbeatConfig['activeHours'],
  nowMs?: number,
): boolean {
  if (!activeHours) return true

  const { start, end, timezone } = activeHours

  const startMinutes = parseHHMM(start)
  const endMinutes = parseHHMM(end)
  if (startMinutes === null || endMinutes === null) return true

  const nowMinutes = currentMinutesInTimezone(timezone, nowMs)

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function currentMinutesInTimezone(tz: string, nowMs?: number): number {
  const date = nowMs ? new Date(nowMs) : new Date()
  if (tz === 'local') {
    return date.getHours() * 60 + date.getMinutes()
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    const parts = fmt.formatToParts(date)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    return date.getHours() * 60 + date.getMinutes()
  }
}

// ==================== Dedup ====================

/**
 * Suppress identical heartbeat notify_user texts within a time window
 * (default 24h). In-memory only — restart loses dedup state. Acceptable
 * trade-off: heartbeats are coarse-grained (~30m), restart-window
 * collisions are rare, single-duplicate cost is low.
 */
export class HeartbeatDedup {
  /** Public for callers that want to inspect the last-delivered text
   *  (e.g. for the agent.work.done payload's metadata). */
  public lastText: string | null = null
  private lastSentAt = 0
  private windowMs: number

  constructor(windowMs = 24 * 60 * 60 * 1000) {
    this.windowMs = windowMs
  }

  isDuplicate(text: string, nowMs = Date.now()): boolean {
    if (this.lastText === null) return false
    if (text !== this.lastText) return false
    return (nowMs - this.lastSentAt) < this.windowMs
  }

  record(text: string, nowMs = Date.now()): void {
    this.lastText = text
    this.lastSentAt = nowMs
  }
}
