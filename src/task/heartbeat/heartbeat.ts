/**
 * Heartbeat — periodic Alice self-check, Pump-driven.
 *
 * Heartbeat is a recurring "ping Alice every N minutes" service. Prior
 * to this commit, it piggy-backed on the cron engine: registered an
 * internal `__heartbeat__` cron job, subscribed to `cron.fire` filtered
 * by jobName, did its work in the handler. That was conceptual debt —
 * the cron engine should be reserved for user-defined cron jobs from
 * the Automation > Cron UI, and heartbeat's lifecycle (active-hours,
 * dedup, hot enable/disable, configured prompt) doesn't belong in a
 * "user cron job" shape.
 *
 * Now: heartbeat owns a private Pump for its schedule and a
 * ProducerHandle for `agent.work.{requested,skip}` emits. The cron
 * engine is no longer in its dependency graph.
 *
 * On each tick:
 *   1. Active-hours pre-filter. Outside hours → emit
 *      `agent.work.skip { source: 'heartbeat', reason: 'outside-active-hours' }`
 *      and return; AI is never invoked, no token cost.
 *   2. Otherwise emit `agent.work.requested { source: 'heartbeat',
 *      prompt }`. The agent-work-listener routes it through the
 *      heartbeat source config (notify_user inspection + dedup gate)
 *      registered at start().
 *
 * State heartbeat owns: HeartbeatDedup (24h window), active-hours
 * config, the Pump, the ProducerHandle, the source config registered
 * with agent-work-listener. AgentWork pipeline state (sessions,
 * AI invocation) lives elsewhere.
 */

import { SessionStore } from '../../core/session.js'
import { writeConfigSection } from '../../core/config.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import type { ProducerHandle } from '../../core/producer.js'
import { createPump, type Pump } from '../../core/pump.js'
import type { AgentWorkListener, AgentWorkSourceConfig } from '../../core/agent-work-listener.js'
import type { AgentWorkResultProbe } from '../../core/agent-work.js'

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
  /** Listener registry — used to declare the heartbeat producer so its
   *  agent.work.{requested,skip} emits are validated + show in the
   *  topology graph. */
  registry: ListenerRegistry
  /** Optional: inject a session for testing. */
  session?: SessionStore
  /** Inject clock for testing. */
  now?: () => number
}

export interface Heartbeat {
  start(): Promise<void>
  stop(): void
  /** Hot-toggle heartbeat on/off (persists to config + updates pump). */
  setEnabled(enabled: boolean): Promise<void>
  /** Current enabled state. */
  isEnabled(): boolean
  /** Manually trigger a heartbeat tick — used by tests and "run now" UI. */
  runNow(): Promise<void>
}

// ==================== Factory ====================

export function createHeartbeat(opts: HeartbeatOpts): Heartbeat {
  const { config, agentWorkListener, registry } = opts
  const session = opts.session ?? new SessionStore('heartbeat')
  const now = opts.now ?? Date.now

  let enabled = config.enabled
  let started = false
  let producer: ProducerHandle<readonly ['agent.work.requested', 'agent.work.skip']> | null = null
  let pump: Pump | null = null

  const dedup = new HeartbeatDedup()

  // ---- Source config (registered with agent-work-listener) ----
  //
  // Output-side semantics (notify_user inspection + dedup gate) live
  // here, closing over the dedup instance heartbeat owns. The
  // agent-work-listener calls these when an agent.work.requested event
  // with source='heartbeat' arrives.
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

  /** The pump's tick callback — active-hours guard then emit. */
  async function onTick(): Promise<void> {
    const startMs = now()
    console.log(`heartbeat: firing at ${new Date(startMs).toISOString()}`)

    if (!isWithinActiveHours(config.activeHours, now())) {
      await producer!.emit('agent.work.skip', {
        source: 'heartbeat',
        reason: 'outside-active-hours',
      })
      console.log(`heartbeat: skipped (outside-active-hours)`)
      return
    }

    await producer!.emit('agent.work.requested', {
      source: 'heartbeat',
      prompt: config.prompt,
    })
  }

  return {
    async start() {
      if (started) return
      started = true

      producer = registry.declareProducer({
        name: 'heartbeat',
        emits: ['agent.work.requested', 'agent.work.skip'] as const,
      })
      agentWorkListener.registerSource(sourceConfig)

      pump = createPump({
        name: 'heartbeat',
        every: config.every,
        enabled,
        onTick,
      })
      pump.start()
    },

    stop() {
      if (!started) return
      pump?.stop()
      pump = null
      producer?.dispose()
      producer = null
      started = false
    },

    async setEnabled(newEnabled: boolean) {
      enabled = newEnabled
      pump?.setEnabled(newEnabled)
      await writeConfigSection('heartbeat', { ...config, enabled: newEnabled })
    },

    isEnabled() {
      return enabled
    },

    async runNow() {
      if (pump) await pump.runNow()
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
  /** Public for callers that want to inspect the last-delivered text. */
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
