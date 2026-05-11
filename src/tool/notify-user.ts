import { tool } from 'ai'
import { z } from 'zod'

/**
 * notify_user — Alice's structured way to express "deliver this to
 * the user" intent during autonomous work.
 *
 * Used by the heartbeat trigger source to replace the legacy STATUS
 * regex protocol (`STATUS: HEARTBEAT_OK | CHAT_YES + CONTENT: ...`).
 * The runner-side outputGate inspects the captured tool calls in
 * `ProviderResult.toolCalls`; if `notify_user` was invoked, the gate
 * routes the tool's `text` arg through the configured dedup window
 * and into `connectorCenter.notify`.
 *
 * **Why no side-effects in execute**: the actual delivery is gated
 * by the AgentWork outputGate (heartbeat applies dedup, future
 * triggers might apply other policies). Putting `connectorCenter.notify`
 * inside the tool's execute would make those gates impossible without
 * per-tool-instance source state. The runner-side gate is the right
 * control point. The tool's job is purely to signal intent + arguments.
 *
 * Globally registered by ToolCenter — every session sees it in its
 * tool catalog. But only sessions whose persona prompt teaches Alice
 * when to call it (today: heartbeat) actually exercise it. cron and
 * task-router sessions don't reference it in their preambles, so AI
 * keeps its current "every reply pushes" behaviour.
 */
export function createNotifyUserTool() {
  return {
    notify_user: tool({
      description: [
        'Send a notification to the user. Use this during autonomous',
        'work (heartbeat / cron / external task) when something is',
        'worth surfacing — a market event, a finished analysis,',
        'a heads-up. Write the body in the user\'s language. Do not',
        'call this redundantly — one call per cycle is the norm. If',
        'nothing is worth flagging, simply do not call this tool.',
      ].join(' '),
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .describe(
            'The notification body, in the user\'s language. Keep it concise — under ~300 chars where possible.',
          ),
        urgency: z
          .enum(['info', 'important'])
          .optional()
          .describe(
            '"info" (default) for routine surfacing; "important" for time-sensitive matters the user should see promptly.',
          ),
      }),
      execute: async ({ text, urgency }) => {
        // Intent-only signal — the AgentWork runner's outputGate
        // observes this call via ProviderResult.toolCalls and routes
        // through dedup / connectorCenter.notify. Returning success
        // here doesn't mean the user has been pinged yet; it means
        // Alice's intent has been recorded for the runner to act on.
        return { acknowledged: true, text, urgency: urgency ?? 'info' }
      },
    }),
  }
}
