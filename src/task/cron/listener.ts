/**
 * Cron Listener — translates user-defined cron job fires into
 * canonical `agent.work.requested` events. The agent-work-listener
 * picks them up and runs the AI dispatch pipeline.
 *
 * Filters out internal `__*__` jobs (heartbeat / snapshot have their
 * own handlers). Serial-execution lock preserved from previous design
 * so concurrent fires don't overlap.
 *
 * No notification policy lives here — every successful cron reply is
 * pushed (the AgentWork default). Cron jobs that want
 * AI-decides-to-notify semantics can teach their prompt about
 * `notify_user`; the source config registered here doesn't reference
 * any output gate, so the default deliver-result.text behaviour wins.
 */

import type { EventLogEntry } from '../../core/event-log.js'
import type { CronFirePayload } from '../../core/agent-event.js'
import { SessionStore } from '../../core/session.js'
import type { Listener, ListenerContext } from '../../core/listener.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import type { AgentWorkListener, AgentWorkSourceConfig } from '../../core/agent-work-listener.js'

function isInternalJob(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__')
}

const CRON_EMITS = ['agent.work.requested'] as const
type CronEmits = typeof CRON_EMITS

export interface CronListenerOpts {
  agentWorkListener: AgentWorkListener
  /** Registry to auto-register this listener with. */
  registry: ListenerRegistry
  /** Optional: inject a session for testing. Otherwise creates a dedicated cron session. */
  session?: SessionStore
}

export interface CronListener {
  start(): Promise<void>
  stop(): void
  readonly listener: Listener<'cron.fire', CronEmits>
}

export function createCronListener(opts: CronListenerOpts): CronListener {
  const { agentWorkListener, registry } = opts
  const session = opts.session ?? new SessionStore('cron/default')

  let processing = false
  let registered = false

  const sourceConfig: AgentWorkSourceConfig = {
    source: 'cron',
    session,
    preamble: (metadata) => {
      const jobName = (metadata as { jobName?: string } | undefined)?.jobName
      return `You are operating in the cron job context (session: cron/default${jobName ? `, job: ${jobName}` : ''}). This is an automated cron job execution.`
    },
    // No output gate — every successful reply is pushed (default
    // AgentWork behaviour matches today's cron semantics).
    buildDoneMetadata: (req) => {
      const m = req.metadata as { jobId?: string; jobName?: string }
      return { jobId: m.jobId, jobName: m.jobName }
    },
    buildErrorMetadata: (req) => {
      const m = req.metadata as { jobId?: string; jobName?: string }
      return { jobId: m.jobId, jobName: m.jobName }
    },
  }

  const listener: Listener<'cron.fire', CronEmits> = {
    name: 'cron-router',
    subscribes: 'cron.fire',
    emits: CRON_EMITS,
    async handle(
      entry: EventLogEntry<CronFirePayload>,
      ctx: ListenerContext<CronEmits>,
    ): Promise<void> {
      const payload = entry.payload

      // Internal jobs have dedicated handlers (heartbeat / snapshot)
      if (isInternalJob(payload.jobName)) return

      if (processing) {
        console.warn(`cron-listener: skipping job ${payload.jobId} (already processing)`)
        return
      }

      processing = true
      try {
        await ctx.emit('agent.work.requested', {
          source: 'cron',
          prompt: payload.payload,
          metadata: { jobId: payload.jobId, jobName: payload.jobName },
        })
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
      agentWorkListener.registerSource(sourceConfig)
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
