/**
 * Notifications HTTP routes — read history + live SSE stream.
 *
 *   GET  /history?limit=&before=&source=  paginated, newest-first
 *   GET  /stream                          SSE feed of fresh appends
 *
 * Both back the Web UI's notification panel. Other connectors that want
 * to consume notifications subscribe to `notificationsStore.onAppended`
 * directly in-process instead of going over HTTP.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import type { INotificationsStore, NotificationSource } from '../../../core/notifications-store.js'

export interface SSEClient {
  id: string
  send: (data: string) => void
}

export interface NotificationsRoutesDeps {
  notificationsStore: INotificationsStore
  /** Shared map of currently-connected stream clients; the plugin owns it
   *  so it can broadcast onAppended without holding a reference to this
   *  router instance. */
  notificationsSSE: Map<string, SSEClient>
}

export function createNotificationsRoutes(deps: NotificationsRoutesDeps) {
  const app = new Hono()

  app.get('/history', async (c) => {
    const limit = Number(c.req.query('limit')) || 100
    const before = c.req.query('before') || undefined
    const source = c.req.query('source') as NotificationSource | undefined
    const result = await deps.notificationsStore.read({ limit, before, source })
    return c.json(result)
  })

  app.get('/stream', (c) => {
    return streamSSE(c, async (stream) => {
      const clientId = randomUUID()
      deps.notificationsSSE.set(clientId, {
        id: clientId,
        send: (data) => { stream.writeSSE({ data }).catch(() => {}) },
      })

      const pingInterval = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }, 30_000)

      stream.onAbort(() => {
        clearInterval(pingInterval)
        deps.notificationsSSE.delete(clientId)
      })

      // Hold the connection open. Closes via onAbort when the client
      // disconnects.
      await new Promise<void>(() => {})
    })
  })

  return app
}
