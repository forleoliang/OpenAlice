/**
 * Diary route — exposes the heartbeat session as a read-only status feed.
 *
 * This is the "status" surface (as opposed to the Chat "notification" surface):
 * a passive view of what Alice has been thinking across recent heartbeat cycles,
 * including silent acknowledgements that never reach Chat.
 *
 * Data sources (joined by timestamp proximity):
 *   - SessionStore('heartbeat')           → full AI turns (prompt, reasoning, tool calls, reply)
 *   - EventLog agent.work.{done,skip,error} filtered by source='heartbeat'
 *                                         → outcome metadata (delivered, reason, durationMs)
 *
 * Heartbeat-attributable events all flow through the canonical AgentWork
 * event types now; we filter on `payload.source === 'heartbeat'`. (Pre-AgentWork
 * the heartbeat module had its own `heartbeat.*` event types; consolidated
 * during the AgentWork upstreams refactor.)
 *
 * Deliberately polling-only (no SSE). Heartbeat fires ~every 30min; the overhead
 * of a persistent subscription is not justified for this frequency.
 */

import { Hono } from 'hono'
import type { EngineContext } from '../../core/types.js'
import { SessionStore, toChatHistory, type ChatHistoryItem } from '../../core/session.js'
import type { EventLogEntry } from '../../core/event-log.js'
import type {
  AgentWorkDonePayload,
  AgentWorkSkipPayload,
  AgentWorkErrorPayload,
} from '../../core/agent-event.js'

// ==================== Types ====================

export type DiaryOutcome =
  | 'delivered'      // agent.work.done, delivered=true, source=heartbeat
  | 'silent-ok'      // agent.work.done delivered=false, or skip.reason=ack
  | 'duplicate'      // skip.reason=duplicate
  | 'empty'          // skip.reason=empty
  | 'outside-hours'  // skip.reason=outside-active-hours
  | 'error'          // agent.work.error, source=heartbeat

export interface DiaryCycle {
  seq: number
  ts: number
  outcome: DiaryOutcome
  reason?: string
  durationMs?: number
}

export interface DiaryHistoryResponse {
  items: ChatHistoryItem[]
  cycles: DiaryCycle[]
  latestSeq: number
}

// ==================== Constants ====================

const AGENT_WORK_EVENT_TYPES = ['agent.work.done', 'agent.work.skip', 'agent.work.error'] as const

/** Slack when joining session entries to cycles by timestamp — covers cron.fire → session.appendUser → ... → event.append gaps. */
const INCREMENTAL_SLACK_MS = 5_000

/** Default cap on session entries returned on a full fetch. Each cycle yields ~1-3 entries. */
const FULL_FETCH_ENTRY_CAP = 400

// ==================== Module-scoped session ====================

// Reuse a single SessionStore instance across requests to avoid re-allocating
// on every poll. The JSONL file is still re-read per request via readActive().
let heartbeatSession: SessionStore | null = null

function getHeartbeatSession(): SessionStore {
  if (!heartbeatSession) {
    heartbeatSession = new SessionStore('heartbeat')
  }
  return heartbeatSession
}

// ==================== Event → cycle mapping ====================

/** Type predicate: is this canonical agent-work event a heartbeat one? */
function isHeartbeatAgentWorkEvent(entry: EventLogEntry): boolean {
  const payload = entry.payload as { source?: string } | null | undefined
  return payload?.source === 'heartbeat'
}

/** Classify a heartbeat-sourced agent-work event into a user-visible outcome. */
export function outcomeFromEvent(entry: EventLogEntry): DiaryOutcome {
  if (entry.type === 'agent.work.done') {
    return (entry.payload as AgentWorkDonePayload).delivered ? 'delivered' : 'silent-ok'
  }
  if (entry.type === 'agent.work.skip') {
    const reason = (entry.payload as AgentWorkSkipPayload).reason
    switch (reason) {
      case 'ack': return 'silent-ok'
      case 'duplicate': return 'duplicate'
      case 'empty': return 'empty'
      case 'outside-active-hours': return 'outside-hours'
      default: return 'silent-ok'
    }
  }
  if (entry.type === 'agent.work.error') return 'error'
  return 'silent-ok'
}

/** Project event-log entries into display cycles. */
export function buildDiaryCycles(events: EventLogEntry[]): DiaryCycle[] {
  return events.map((e) => {
    const outcome = outcomeFromEvent(e)
    let reason: string | undefined
    let durationMs: number | undefined

    if (e.type === 'agent.work.done') {
      const p = e.payload as AgentWorkDonePayload
      durationMs = p.durationMs
      // No source-specific reason field — done events just have reply text.
    } else if (e.type === 'agent.work.skip') {
      const p = e.payload as AgentWorkSkipPayload
      // The heartbeat outputGate stuffs the (truncated) notify_user text into
      // metadata.parsedReason for duplicate skips. Prefer that over the
      // machine-facing reason code.
      const parsedReason = (p.metadata as { parsedReason?: string } | undefined)?.parsedReason
      reason = parsedReason ?? p.reason
    } else if (e.type === 'agent.work.error') {
      const p = e.payload as AgentWorkErrorPayload
      reason = p.error
      durationMs = p.durationMs
    }

    return { seq: e.seq, ts: e.ts, outcome, reason, durationMs }
  })
}

// ==================== Route factory ====================

export function createDiaryRoutes(ctx: EngineContext) {
  const app = new Hono()

  /**
   * GET /history?limit=100&afterSeq=123
   *
   * - afterSeq omitted (or 0): full fetch — last `limit` cycles + recent session items.
   * - afterSeq > 0: incremental — only cycles with seq > afterSeq and session items
   *   timestamped after the oldest new cycle (minus slack for prompt-before-reply gap).
   */
  app.get('/history', async (c) => {
    const limit = clamp(Number(c.req.query('limit')) || 100, 1, 500)
    const afterSeq = Math.max(0, Number(c.req.query('afterSeq')) || 0)

    // Read from disk, not the in-memory ring buffer.
    // The ring buffer (~500 entries) gets saturated by high-frequency events
    // (snapshot.skipped, account.health), evicting older heartbeat entries —
    // the activity we care about here fires only ~every 30min.
    // One disk scan with in-memory type+source filtering is cheaper than three.
    const allEvents = await ctx.eventLog.read({ afterSeq })
    const typeSet = new Set<string>(AGENT_WORK_EVENT_TYPES)
    const events = allEvents.filter(
      (e) => typeSet.has(e.type) && isHeartbeatAgentWorkEvent(e),
    )
    const cycles = buildDiaryCycles(events).slice(-limit)

    // Read heartbeat session entries.
    const session = getHeartbeatSession()
    const entries = await session.readActive()

    let items: ChatHistoryItem[]
    if (afterSeq > 0) {
      if (cycles.length === 0) {
        items = []
      } else {
        const cutoff = cycles[0].ts - INCREMENTAL_SLACK_MS
        const sliced = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff)
        items = toChatHistory(sliced)
      }
    } else {
      const capped = entries.slice(-Math.max(FULL_FETCH_ENTRY_CAP, limit * 4))
      items = toChatHistory(capped)
    }

    const response: DiaryHistoryResponse = {
      items,
      cycles,
      latestSeq: ctx.eventLog.lastSeq(),
    }
    return c.json(response)
  })

  return app
}

// ==================== Helpers ====================

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
