/**
 * Heartbeat tests — exercises the full trigger-source pipeline:
 *
 *   cron.fire (__heartbeat__)
 *     → heartbeat listener handleFire()
 *       → active-hours pre-filter (emits agent.work.skip directly if blocked)
 *       → emits agent.work.requested
 *     → agent-work-listener (separate test fixture)
 *       → AgentWorkRunner.run()
 *         → notify_user-inspection outputGate (with dedup)
 *         → emits agent.work.done / .skip / .error
 *
 * The legacy STATUS regex protocol is gone; notification intent is
 * signalled via the notify_user tool. These tests mock the AgentCenter
 * result to include or omit the tool call and assert on canonical
 * agent.work.* events with source='heartbeat'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import { createCronEngine, type CronEngine } from '../cron/engine.js'
import {
  createHeartbeat,
  isWithinActiveHours,
  HeartbeatDedup,
  HEARTBEAT_JOB_NAME,
  type Heartbeat,
  type HeartbeatConfig,
} from './heartbeat.js'
import { SessionStore } from '../../core/session.js'
import { ConnectorCenter } from '../../core/connector-center.js'
import { createMemoryNotificationsStore } from '../../core/notifications-store.js'
import { AgentWorkRunner } from '../../core/agent-work.js'
import { createAgentWorkListener, type AgentWorkListener } from '../../core/agent-work-listener.js'
import type { ToolCallSummary } from '../../ai-providers/types.js'
import type { AgentWorkDonePayload, AgentWorkSkipPayload, AgentWorkErrorPayload } from '../../core/agent-event.js'

vi.mock('../../core/config.js', () => ({
  writeConfigSection: vi.fn(async () => ({})),
}))

function tempPath(ext: string): string {
  return join(tmpdir(), `heartbeat-test-${randomUUID()}.${ext}`)
}

function makeConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    enabled: true,
    every: '30m',
    prompt: 'Check if anything needs attention.',
    activeHours: null,
    ...overrides,
  }
}

// ==================== Mock Engine ====================

interface MockEngineState {
  text: string
  toolCalls: ToolCallSummary[]
  shouldThrow: Error | null
}

function createMockEngine(initial: Partial<MockEngineState> = {}) {
  const state: MockEngineState = {
    text: '',
    toolCalls: [],
    shouldThrow: null,
    ...initial,
  }
  return {
    state,
    setNotifyUserCall(text: string) {
      state.toolCalls = [{ id: randomUUID(), name: 'notify_user', input: { text } }]
    },
    setNoToolCall() { state.toolCalls = [] },
    setRawText(text: string) { state.text = text },
    setShouldThrow(err: Error | null) { state.shouldThrow = err },
    askWithSession: vi.fn(async () => {
      if (state.shouldThrow) throw state.shouldThrow
      return { text: state.text, media: [], toolCalls: state.toolCalls }
    }),
    ask: vi.fn(),
  }
}

// ==================== Integration suite ====================

describe('heartbeat', () => {
  let eventLog: EventLog
  let listenerRegistry: ListenerRegistry
  let cronEngine: CronEngine
  let heartbeat: Heartbeat
  let mockEngine: ReturnType<typeof createMockEngine>
  let session: SessionStore
  let connectorCenter: ConnectorCenter
  let notificationsStore: ReturnType<typeof createMemoryNotificationsStore>
  let agentWorkListener: AgentWorkListener

  beforeEach(async () => {
    const logPath = tempPath('jsonl')
    const storePath = tempPath('json')
    eventLog = await createEventLog({ logPath })
    listenerRegistry = createListenerRegistry(eventLog)
    await listenerRegistry.start()
    cronEngine = createCronEngine({ registry: listenerRegistry, storePath })
    await cronEngine.start()

    mockEngine = createMockEngine()
    session = new SessionStore(`test/heartbeat-${randomUUID()}`)
    notificationsStore = createMemoryNotificationsStore()
    connectorCenter = new ConnectorCenter({ notificationsStore })
    const runner = new AgentWorkRunner({
      agentCenter: mockEngine as never,
      connectorCenter,
    })
    agentWorkListener = createAgentWorkListener({ runner, registry: listenerRegistry })
    await agentWorkListener.start()
  })

  afterEach(async () => {
    heartbeat?.stop()
    agentWorkListener.stop()
    cronEngine.stop()
    await listenerRegistry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Start / Idempotency ====================

  describe('start', () => {
    it('registers a cron job on start', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      const jobs = cronEngine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].name).toBe(HEARTBEAT_JOB_NAME)
      expect(jobs[0].schedule).toEqual({ kind: 'every', every: '30m' })
    })

    it('idempotent (update existing job, not create duplicate)', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ every: '30m' }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      heartbeat.stop()

      heartbeat = createHeartbeat({
        config: makeConfig({ every: '1h' }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      const jobs = cronEngine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].schedule).toEqual({ kind: 'every', every: '1h' })
    })

    it('registers disabled job when config.enabled is false', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      const jobs = cronEngine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].enabled).toBe(false)
      expect(heartbeat.isEnabled()).toBe(false)
    })
  })

  // ==================== Event Handling ====================

  describe('event handling', () => {
    it('delivers when AI calls notify_user', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      mockEngine.setNotifyUserCall('BTC dropped 5% to $87,200')

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      expect(delivered).toEqual(['BTC dropped 5% to $87,200'])
      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.source).toBe('heartbeat')
      expect(done.delivered).toBe(true)
    })

    it('skips with reason=ack when AI does not call notify_user', async () => {
      mockEngine.setRawText('Checked, nothing notable.')
      mockEngine.setNoToolCall()

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.source).toBe('heartbeat')
      expect(skip.reason).toBe('ack')
      expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(0)
    })

    it('skips with reason=empty when notify_user.text is blank', async () => {
      mockEngine.setNotifyUserCall('   ')

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.reason).toBe('empty')
    })

    it('does NOT regex-parse STATUS-shaped raw text — anti-regression', async () => {
      // Legacy protocol response — must NOT trigger any notification.
      mockEngine.setRawText('STATUS: CHAT_YES\nCONTENT: should NOT be delivered')
      mockEngine.setNoToolCall()

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const { entries } = await notificationsStore.read()
      expect(entries).toHaveLength(0)
    })

    it('ignores non-heartbeat cron.fire events', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await eventLog.append('cron.fire', {
        jobId: 'other-job',
        jobName: 'check-eth',
        payload: 'Check ETH',
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== Active Hours ====================

  describe('active hours', () => {
    it('emits agent.work.skip with reason=outside-active-hours, without invoking AI', async () => {
      const fakeNow = new Date('2025-06-15T03:00:00').getTime() // 3 AM local

      heartbeat = createHeartbeat({
        config: makeConfig({
          activeHours: { start: '09:00', end: '22:00', timezone: 'local' },
        }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
        now: () => fakeNow,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.source).toBe('heartbeat')
      expect(skip.reason).toBe('outside-active-hours')
      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      // No agent.work.requested was emitted (pre-emit gate)
      const reqs = eventLog.recent({ type: 'agent.work.requested' })
      expect(reqs.filter(e => (e.payload as { source: string }).source === 'heartbeat')).toHaveLength(0)
    })
  })

  // ==================== Dedup ====================

  describe('dedup', () => {
    it('suppresses duplicate notify_user texts within the dedup window', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      mockEngine.setNotifyUserCall('BTC dropped 5%')

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      const jobId = cronEngine.list()[0].id

      await cronEngine.runNow(jobId)
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      await cronEngine.runNow(jobId)
      await vi.waitFor(() => {
        const skips = eventLog.recent({ type: 'agent.work.skip' })
        expect(skips.some(s => (s.payload as AgentWorkSkipPayload).reason === 'duplicate')).toBe(true)
      })

      expect(delivered).toHaveLength(1)
    })

    it('different notify_user texts are not deduped', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      const jobId = cronEngine.list()[0].id

      mockEngine.setNotifyUserCall('First alert')
      await cronEngine.runNow(jobId)
      await vi.waitFor(() => { expect(delivered).toHaveLength(1) })

      mockEngine.setNotifyUserCall('Second different alert')
      await cronEngine.runNow(jobId)
      await vi.waitFor(() => { expect(delivered).toHaveLength(2) })

      expect(delivered).toEqual(['First alert', 'Second different alert'])
    })
  })

  // ==================== Error Handling ====================

  describe('error handling', () => {
    it('emits agent.work.error on AI failure', async () => {
      mockEngine.setShouldThrow(new Error('AI down'))

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.error' })).toHaveLength(1)
      })

      const err = eventLog.recent({ type: 'agent.work.error' })[0].payload as AgentWorkErrorPayload
      expect(err.source).toBe('heartbeat')
      expect(err.error).toBe('AI down')
    })

    it('handles notify failure — emits done with delivered=false', async () => {
      mockEngine.setNotifyUserCall('alert text')
      const originalAppend = notificationsStore.append.bind(notificationsStore)
      notificationsStore.append = async () => { throw new Error('store failed') }

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.delivered).toBe(false)

      notificationsStore.append = originalAppend
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('stops listening after stop()', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      heartbeat.stop()

      await cronEngine.runNow(cronEngine.list()[0].id)
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== setEnabled ====================

  describe('setEnabled', () => {
    it('enables a previously disabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(false)
      expect(cronEngine.list()[0].enabled).toBe(false)

      await heartbeat.setEnabled(true)
      expect(heartbeat.isEnabled()).toBe(true)
      expect(cronEngine.list()[0].enabled).toBe(true)
    })

    it('disables an enabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: true }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(true)

      await heartbeat.setEnabled(false)
      expect(heartbeat.isEnabled()).toBe(false)
      expect(cronEngine.list()[0].enabled).toBe(false)
    })

    it('persists config via writeConfigSection', async () => {
      const { writeConfigSection } = await import('../../core/config.js')

      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.setEnabled(true)

      expect(writeConfigSection).toHaveBeenCalledWith(
        'heartbeat',
        expect.objectContaining({ enabled: true }),
      )
    })

    it('allows firing after setEnabled(true)', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      mockEngine.setNotifyUserCall('after-enable')

      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.setEnabled(true)
      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => { expect(delivered).toHaveLength(1) })
      expect(delivered[0]).toBe('after-enable')
    })
  })
})

// ==================== Unit: isWithinActiveHours ====================

describe('isWithinActiveHours', () => {
  it('returns true when no active hours configured', () => {
    expect(isWithinActiveHours(null)).toBe(true)
  })

  it('returns true within normal range', () => {
    const ts = todayAt(15, 0).getTime()
    expect(isWithinActiveHours(
      { start: '09:00', end: '22:00', timezone: 'local' }, ts,
    )).toBe(true)
  })

  it('returns false outside normal range', () => {
    const ts = todayAt(3, 0).getTime()
    expect(isWithinActiveHours(
      { start: '09:00', end: '22:00', timezone: 'local' }, ts,
    )).toBe(false)
  })

  it('handles overnight range (22:00 → 06:00)', () => {
    expect(isWithinActiveHours(
      { start: '22:00', end: '06:00', timezone: 'local' },
      todayAt(23, 0).getTime(),
    )).toBe(true)
    expect(isWithinActiveHours(
      { start: '22:00', end: '06:00', timezone: 'local' },
      todayAt(3, 0).getTime(),
    )).toBe(true)
    expect(isWithinActiveHours(
      { start: '22:00', end: '06:00', timezone: 'local' },
      todayAt(12, 0).getTime(),
    )).toBe(false)
  })

  it('handles invalid format gracefully (returns true)', () => {
    expect(isWithinActiveHours(
      { start: 'invalid', end: '22:00', timezone: 'local' },
    )).toBe(true)
  })
})

// ==================== Unit: HeartbeatDedup ====================

describe('HeartbeatDedup', () => {
  it('does not flag first message as duplicate', () => {
    const d = new HeartbeatDedup()
    expect(d.isDuplicate('hello')).toBe(false)
  })

  it('flags same text within window', () => {
    const d = new HeartbeatDedup(1000)
    d.record('hello', 100)
    expect(d.isDuplicate('hello', 500)).toBe(true)
  })

  it('does not flag same text after window expires', () => {
    const d = new HeartbeatDedup(1000)
    d.record('hello', 100)
    expect(d.isDuplicate('hello', 1200)).toBe(false)
  })

  it('does not flag different text', () => {
    const d = new HeartbeatDedup(1000)
    d.record('hello', 100)
    expect(d.isDuplicate('world', 500)).toBe(false)
  })

  it('exposes lastText', () => {
    const d = new HeartbeatDedup()
    expect(d.lastText).toBeNull()
    d.record('first', 100)
    expect(d.lastText).toBe('first')
    d.record('second', 200)
    expect(d.lastText).toBe('second')
  })
})

// ==================== Helpers ====================

function todayAt(h: number, m: number): Date {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}
