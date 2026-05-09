import { useEffect, useState } from 'react'

interface LiveIndicatorProps {
  /** Pass `null` to render the pulse without a timestamp (i.e. before the
   *  first successful fetch lands). */
  lastUpdated: Date | null
  /** Hide the breathing dot — only show "updated Xs ago" microcopy. */
  hideDot?: boolean
  className?: string
}

/**
 * "This surface is alive" badge — a small breathing green dot plus a
 * relative-time microcopy ("updated 14s ago") that re-renders every 5s
 * so the number stays honest even when the parent isn't re-rendering.
 *
 * Trading-app convention: the dot communicates "data is auto-refreshing"
 * without taking real estate. Drop it next to a PageHeader title or any
 * place a user might wonder "is this live?".
 */
export function LiveIndicator({ lastUpdated, hideDot, className }: LiveIndicatorProps) {
  // Tick once every 5s so "Xs ago" doesn't go stale visually.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const ago = lastUpdated ? formatAgo(lastUpdated) : '—'

  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] text-text-muted ${className ?? ''}`}>
      {!hideDot && (
        <span className="relative inline-block w-1.5 h-1.5 rounded-full bg-green live-pulse" aria-hidden />
      )}
      <span className="tabular-nums">updated {ago}</span>
    </span>
  )
}

function formatAgo(d: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}
