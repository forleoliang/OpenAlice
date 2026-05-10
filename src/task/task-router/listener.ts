/**
 * Task Router — subscribes to externally-ingested `task.requested` events
 * (POST /api/events/ingest) and submits each as an AgentWork.
 *
 * Flow:
 *   POST /api/events/ingest { type: 'task.requested', payload: { prompt } }
 *     → eventLog 'task.requested'
 *     → AgentWorkRunner: AI call → notify → emit task.done / task.error
 *
 * The listener owns a dedicated SessionStore for externally-triggered
 * tasks (`task/default`), independent of cron, heartbeat, and chat
 * sessions, so external callers don't accidentally see (or pollute)
 * conversation history that wasn't meant for them.
 *
 * Like cron, this listener does NOT teach Alice about `notify_user` —
 * external tasks default to the same "every reply pushes" behaviour.
 * A specific external integration that wants AI-decides-to-notify
 * semantics would set that up in its own prompt + outputGate.
 */

import type { EventLogEntry } from '../../core/event-log.js'
import type { TaskRequestedPayload } from '../../core/agent-event.js'
import type { AgentWorkRunner } from '../../core/agent-work.js'
import { SessionStore } from '../../core/session.js'
import type { Listener, ListenerContext } from '../../core/listener.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'

// ==================== Types ====================

const TASK_EMITS = ['task.done', 'task.error'] as const
type TaskEmits = typeof TASK_EMITS

export interface TaskRouterOpts {
  agentWorkRunner: AgentWorkRunner
  /** Registry to auto-register this listener with. */
  registry: ListenerRegistry
  /** Optional: inject a session for testing. Otherwise creates `task/default`. */
  session?: SessionStore
}

export interface TaskRouter {
  /** Register the listener with the registry (idempotent). */
  start(): Promise<void>
  /** Unregister the listener from the registry. */
  stop(): void
  /** Expose the raw Listener object (for testing `handle()` directly). */
  readonly listener: Listener<'task.requested', TaskEmits>
}

// ==================== Factory ====================

export function createTaskRouter(opts: TaskRouterOpts): TaskRouter {
  const { agentWorkRunner, registry } = opts
  const session = opts.session ?? new SessionStore('task/default')

  let processing = false
  let registered = false

  const listener: Listener<'task.requested', TaskEmits> = {
    name: 'task-router',
    subscribes: 'task.requested',
    emits: TASK_EMITS,
    async handle(
      entry: EventLogEntry<TaskRequestedPayload>,
      ctx: ListenerContext<TaskEmits>,
    ): Promise<void> {
      const payload = entry.payload

      if (processing) {
        console.warn(`task-router: skipping (already processing)`)
        return
      }

      processing = true
      try {
        await agentWorkRunner.run(
          {
            prompt: payload.prompt,
            session,
            preamble: `You are handling an externally-triggered task (session: task/default). Follow the prompt and reply with what the caller needs.`,
            metadata: { source: 'task', prompt: payload.prompt },
            emitNames: { done: 'task.done', error: 'task.error' },
            buildDonePayload: (req, result, durationMs) => ({
              prompt: req.metadata.prompt as string,
              reply: result.text,
              durationMs,
            }),
            buildErrorPayload: (req, err, durationMs) => ({
              prompt: req.metadata.prompt as string,
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
