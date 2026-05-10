/**
 * Cron Listener — subscribes to `cron.fire` events and submits each as
 * an AgentWork to the runner. The runner owns the AI call → notify →
 * emit pipeline; this listener is a thin trigger source that:
 *
 *   1. Filters out internal `__*__` jobs (heartbeat / snapshot have
 *      their own handlers)
 *   2. Enforces serial execution (no overlapping cron handlings)
 *   3. Builds an AgentWorkRequest with cron-shaped emit names + done
 *      payload
 *   4. Delegates to `runner.run`
 *
 * No notification policy lives here — every successful cron reply is
 * pushed (the AgentWork default). If a future cron job wants
 * AI-decides-to-notify semantics, its prompt can teach Alice about
 * `notify_user` and supply an outputGate; the listener stays unchanged.
 */

import type { EventLogEntry } from '../../core/event-log.js'
import type { CronFirePayload } from '../../core/agent-event.js'
import type { AgentWorkRunner } from '../../core/agent-work.js'
import { SessionStore } from '../../core/session.js'
import type { Listener, ListenerContext } from '../../core/listener.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'

/** Internal jobs (prefixed with __) have dedicated handlers and should not be routed to the AI. */
function isInternalJob(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__')
}

// ==================== Types ====================

const CRON_EMITS = ['cron.done', 'cron.error'] as const
type CronEmits = typeof CRON_EMITS

export interface CronListenerOpts {
  agentWorkRunner: AgentWorkRunner
  /** Registry to auto-register this listener with. */
  registry: ListenerRegistry
  /** Optional: inject a session for testing. Otherwise creates a dedicated cron session. */
  session?: SessionStore
}

export interface CronListener {
  /** Register the listener with the registry (idempotent). */
  start(): Promise<void>
  /** Unregister the listener from the registry. */
  stop(): void
  /** Expose the raw Listener object (for testing `handle()` directly). */
  readonly listener: Listener<'cron.fire', CronEmits>
}

// ==================== Factory ====================

export function createCronListener(opts: CronListenerOpts): CronListener {
  const { agentWorkRunner, registry } = opts
  const session = opts.session ?? new SessionStore('cron/default')

  let processing = false
  let registered = false

  const listener: Listener<'cron.fire', CronEmits> = {
    name: 'cron-router',
    subscribes: 'cron.fire',
    emits: CRON_EMITS,
    async handle(
      entry: EventLogEntry<CronFirePayload>,
      ctx: ListenerContext<CronEmits>,
    ): Promise<void> {
      const payload = entry.payload

      // Internal jobs (__heartbeat__, __snapshot__, etc.) have dedicated handlers
      if (isInternalJob(payload.jobName)) return

      // Serial execution — preserves today's behaviour
      if (processing) {
        console.warn(`cron-listener: skipping job ${payload.jobId} (already processing)`)
        return
      }

      processing = true
      try {
        await agentWorkRunner.run(
          {
            prompt: payload.payload,
            session,
            preamble: `You are operating in the cron job context (session: cron/default, job: ${payload.jobName}). This is an automated cron job execution.`,
            metadata: { source: 'cron', jobId: payload.jobId, jobName: payload.jobName },
            emitNames: { done: 'cron.done', error: 'cron.error' },
            buildDonePayload: (req, result, durationMs) => ({
              jobId: req.metadata.jobId as string,
              jobName: req.metadata.jobName as string,
              reply: result.text,
              durationMs,
            }),
            buildErrorPayload: (req, err, durationMs) => ({
              jobId: req.metadata.jobId as string,
              jobName: req.metadata.jobName as string,
              error: err.message,
              durationMs,
            }),
          },
          ctx.emit as never,
        )
      } finally {
        processing = false
      }
    },
  }

  return {
    listener,
    async start() {
      if (registered) return
      registry.register(listener)
      registered = true
    },
    stop() {
      if (registered) {
        registry.unregister(listener.name)
        registered = false
      }
    },
  }
}
