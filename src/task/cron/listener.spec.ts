import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import { createCronListener, type CronListener } from './listener.js'
import { SessionStore } from '../../core/session.js'
import type { CronFirePayload } from './engine.js'
import { ConnectorCenter } from '../../core/connector-center.js'
import { createMemoryNotificationsStore } from '../../core/notifications-store.js'
import { AgentWorkRunner } from '../../core/agent-work.js'
import { createAgentWorkListener, type AgentWorkListener } from '../../core/agent-work-listener.js'
import type { AgentWorkDonePayload, AgentWorkErrorPayload } from '../../core/agent-event.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `cron-listener-test-${randomUUID()}.${ext}`)
}

// ==================== Mock Engine ====================

function createMockEngine(response = 'AI reply') {
  const calls: Array<{ prompt: string; session: SessionStore }> = []
  let shouldFail = false

  return {
    calls,
    setResponse(text: string) { response = text },
    setShouldFail(val: boolean) { shouldFail = val },
    askWithSession: vi.fn(async (prompt: string, session: SessionStore) => {
      calls.push({ prompt, session })
      if (shouldFail) throw new Error('engine error')
      return { text: response, media: [] }
    }),
    ask: vi.fn(),
  }
}

describe('cron listener', () => {
  let eventLog: EventLog
  let registry: ListenerRegistry
  let cronListener: CronListener
  let agentWorkListener: AgentWorkListener
  let mockEngine: ReturnType<typeof createMockEngine>
  let session: SessionStore
  let connectorCenter: ConnectorCenter
  let notificationsStore: ReturnType<typeof createMemoryNotificationsStore>

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    registry = createListenerRegistry(eventLog)
    await registry.start()
    mockEngine = createMockEngine()
    session = new SessionStore(`test/cron-${randomUUID()}`)
    notificationsStore = createMemoryNotificationsStore()
    connectorCenter = new ConnectorCenter({ notificationsStore })

    const runner = new AgentWorkRunner({
      agentCenter: mockEngine as never,
      connectorCenter,
    })
    agentWorkListener = createAgentWorkListener({ runner, registry })
    await agentWorkListener.start()

    cronListener = createCronListener({
      agentWorkListener,
      registry,
      session,
    })
    await cronListener.start()
  })

  afterEach(async () => {
    cronListener.stop()
    agentWorkListener.stop()
    await registry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Basic functionality ====================

  describe('event handling', () => {
    it('emits agent.work.requested on cron.fire', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Check the market',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.requested' })).toHaveLength(1)
      })

      const req = eventLog.recent({ type: 'agent.work.requested' })[0].payload as { source: string; prompt: string; metadata: { jobId: string; jobName: string } }
      expect(req.source).toBe('cron')
      expect(req.prompt).toBe('Check the market')
      expect(req.metadata).toEqual({ jobId: 'abc12345', jobName: 'test-job' })
    })

    it('downstream agent.work.done payload carries source=cron + reply', async () => {
      const fireEntry = await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Do something',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0]
      const payload = done.payload as AgentWorkDonePayload
      expect(payload.source).toBe('cron')
      expect(payload.reply).toBe('AI reply')
      expect(payload.durationMs).toBeGreaterThanOrEqual(0)
      expect(payload.delivered).toBe(true)
      expect(payload.metadata).toMatchObject({ jobId: 'abc12345', jobName: 'test-job' })
      // causality: done is caused by the requested event, which is caused by fire
      expect(typeof done.causedBy).toBe('number')
    })

    it('filters out internal __*__ jobs', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'hb-id',
        jobName: '__heartbeat__',
        payload: 'should be ignored by cron-router',
      } satisfies CronFirePayload)

      await new Promise((r) => setTimeout(r, 50))

      // cron-router didn't emit anything (its filter dropped this)
      const requested = eventLog.recent({ type: 'agent.work.requested' })
      expect(requested.filter(e => (e.payload as { source: string }).source === 'cron')).toHaveLength(0)
    })

    it('does not react to other event types', async () => {
      await eventLog.append('message.received' as never, { channel: 'web', to: 'x', prompt: 'p' })
      await new Promise((r) => setTimeout(r, 50))
      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== Delivery ====================

  describe('delivery', () => {
    it('appends AI reply to notifications store with source=cron', async () => {
      const delivered: Array<{ text: string; source?: string }> = []
      notificationsStore.onAppended((entry) => { delivered.push({ text: entry.text, source: entry.source }) })

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toEqual({ text: 'AI reply', source: 'cron' })
    })
  })

  // ==================== Error handling ====================

  describe('error handling', () => {
    it('emits agent.work.error on engine failure', async () => {
      mockEngine.setShouldFail(true)

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Will fail',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.error' })).toHaveLength(1)
      })

      const err = eventLog.recent({ type: 'agent.work.error' })[0].payload as AgentWorkErrorPayload
      expect(err.source).toBe('cron')
      expect(err.error).toBe('engine error')
      expect(err.metadata).toMatchObject({ jobId: 'abc12345', jobName: 'test-job' })
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('stops emitting after registry.stop()', async () => {
      await registry.stop()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Should not fire',
      } satisfies CronFirePayload)

      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })

    it('is idempotent on repeated start()', async () => {
      await cronListener.start()
      // No error
    })
  })
})
