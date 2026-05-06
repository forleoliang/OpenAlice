import { useState } from 'react'
import { notificationsLive } from '../live/notifications'
import type { NotificationEntry, NotificationSource } from '../api/notifications'

const SOURCE_COLORS: Record<NotificationSource, string> = {
  heartbeat: 'bg-purple/15 text-purple',
  cron: 'bg-accent/15 text-accent',
  task: 'bg-emerald-500/15 text-emerald-400',
  manual: 'bg-amber-500/15 text-amber-400',
}

/**
 * Notifications sidebar — chronological list of every system push (heartbeat,
 * cron, task, manual). Reads from the shared `notificationsLive` LiveStore
 * (one SSE connection regardless of subscriber count). Phase-2 surface:
 * entries collapse to a one-line preview; clicking expands inline.
 *
 * Notification Center is sidebar-only — there's no "open one as a tab"
 * action. The full text usually fits on a few lines, and a tab per
 * notification would clutter the editor area for content that doesn't
 * benefit from persistent focus.
 */
export function NotificationsSidebar() {
  const entries = notificationsLive.useStore((s) => s.entries)
  const loading = notificationsLive.useStore((s) => s.loading)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0 py-0.5">
        {loading && entries.length === 0 ? (
          <p className="px-3 py-1 text-[12px] text-text-muted/60">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-1 text-[12px] text-text-muted/60 leading-snug">
            No notifications yet. Heartbeat, cron jobs and external pushes will land here.
          </p>
        ) : (
          entries.map((entry) => <NotificationRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}

function NotificationRow({ entry }: { entry: NotificationEntry }) {
  const [expanded, setExpanded] = useState(false)
  const preview = entry.text.length > 80 ? entry.text.slice(0, 80) + '…' : entry.text
  const when = formatRelativeTime(entry.ts)
  const source = entry.source

  return (
    <div
      className="border-b border-border/30 last:border-b-0 hover:bg-bg-tertiary/30 transition-colors cursor-pointer"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-baseline gap-1.5 px-3 py-1.5">
        <span className="text-[10px] text-text-muted/60 shrink-0 tabular-nums">{when}</span>
        {source && (
          <span className={`shrink-0 text-[9px] uppercase tracking-wide px-1 rounded ${SOURCE_COLORS[source] ?? 'bg-bg-tertiary text-text-muted'}`}>
            {source}
          </span>
        )}
      </div>
      <div className="px-3 pb-2 -mt-1">
        <p className="text-[12px] text-text whitespace-pre-wrap break-words leading-snug">
          {expanded ? entry.text : preview}
        </p>
      </div>
    </div>
  )
}

/** Compact relative time: "12s", "5m", "3h", "2d", or absolute date for >7d. */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
