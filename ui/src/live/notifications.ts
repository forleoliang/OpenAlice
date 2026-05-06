import { api } from '../api'
import type { NotificationEntry } from '../api/notifications'
import { createLiveStore } from './createLiveStore'
import { connectSSE } from './connectSSE'

/**
 * Live notifications feed. Single shared connection regardless of how
 * many components subscribe; visibility-aware reconnect bakes in via
 * the LiveStore primitive.
 *
 * Initial snapshot: paginated history endpoint. Live tail: SSE stream
 * pushing new appends as they're created. Newest entries land at the
 * front of `entries`.
 */

export interface NotificationsState {
  entries: NotificationEntry[]
  /** True until the initial history fetch resolves. UI shows a skeleton. */
  loading: boolean
}

export const notificationsLive = createLiveStore<NotificationsState>({
  name: 'notifications',
  initialState: { entries: [], loading: true },
  subscribe: ({ apply }) => {
    // 1. Initial snapshot
    api.notifications.history({ limit: 100 }).then(({ entries }) => {
      apply((prev) => ({ ...prev, entries, loading: false }))
    }).catch(() => {
      apply((prev) => ({ ...prev, loading: false }))
    })

    // 2. Live tail
    return connectSSE<NotificationEntry>('/api/notifications/stream', (entry) => {
      apply((prev) => {
        // Drop any existing entry with the same id (defensive — server is
        // append-only, but reconnects could re-deliver).
        const without = prev.entries.filter((e) => e.id !== entry.id)
        return { ...prev, entries: [entry, ...without] }
      })
    })
  },
})
