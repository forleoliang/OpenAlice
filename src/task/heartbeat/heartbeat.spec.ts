/**
 * Heartbeat tests — exercises the full trigger-source pipeline:
 *
 *   cron.fire (__heartbeat__)
 *     → handleFire()
 *       → AgentWorkRunner.run()
 *         → inputGate (active-hours)
 *         → AI invocation
 *         → outputGate (notify_user inspection + dedup)
 *         → connectorCenter.notify (optional)
 *         → emit done / skip / error
 *
 * The legacy STATUS regex protocol is gone. Heartbeat now signals
 * notification intent via the `notify_user` tool — these tests mock
 * the AgentCenter result to include or omit the tool call, and assert
 * on the resulting events.
 *
 * AgentWork primitive coverage lives in `src/core/agent-work.spec.ts`;
 * this file tests heartbeat-specific behaviours: cron job lifecycle,
 * active-hours filtering, dedup window, hot enable/disable, and the
 * heartbeat-specific outputGate semantics.
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
import type { ToolCallSummary } from '../../ai-providers/types.js'

// Mock writeConfigSection to avoid disk writes in tests
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
//
// Returns `{ text, media, toolCalls }` from `askWithSession`. The
// runner unwraps these as ProviderResult; toolCalls is what the
// heartbeat outputGate inspects for notify_user invocations.

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
    setNoToolCall() {
      state.toolCalls = []
    },
    setRawText(text: string) {
      state.text = text
    },
    setShouldThrow(err: Error | null) {
      state.shouldThrow = err
    },
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
  let agentWorkRunner: AgentWorkRunner

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
    agentWorkRunner = new AgentWorkRunner({
      agentCenter: mockEngine as never,
      connectorCenter,
    })
  })

  afterEach(async () => {
    heartbeat?.stop()
    cronEngine.stop()
    await listenerRegistry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Start / Idempotency ====================

  describe('start', () => {
    it('should register a cron job on start', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })

      await heartbeat.start()

      const jobs = cronEngine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].name).toBe(HEARTBEAT_JOB_NAME)
      expect(jobs[0].schedule).toEqual({ kind: 'every', every: '30m' })
    })

    it('should be idempotent (update existing job, not create duplicate)', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ every: '30m' }),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      heartbeat.stop()

      heartbeat = createHeartbeat({
        config: makeConfig({ every: '1h' }),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      const jobs = cronEngine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].schedule).toEqual({ kind: 'every', every: '1h' })
    })

    it('should register disabled job when config.enabled is false', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      const jobs = cronEngine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].enabled).toBe(false)
      expect(heartbeat.isEnabled()).toBe(false)
    })
  })

  // ==================== Event Handling: notify_user contract ====================

  describe('event handling', () => {
    it('delivers when AI invokes notify_user', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      mockEngine.setNotifyUserCall('BTC dropped 5% to $87,200')

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.done' })).toHaveLength(1)
      })

      expect(delivered).toEqual(['BTC dropped 5% to $87,200'])
      const done = eventLog.recent({ type: 'heartbeat.done' })
      expect(done[0].payload).toMatchObject({
        reply: 'BTC dropped 5% to $87,200',
        delivered: true,
      })
    })

    it('skips with reason=ack when AI does not call notify_user', async () => {
      mockEngine.setRawText('Checked. Nothing notable in the last 30 minutes.')
      mockEngine.setNoToolCall()

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.skip' })).toHaveLength(1)
      })

      const skips = eventLog.recent({ type: 'heartbeat.skip' })
      expect(skips[0].payload).toMatchObject({ reason: 'ack' })
      // No notify, no done
      expect(eventLog.recent({ type: 'heartbeat.done' })).toHaveLength(0)
    })

    it('skips with reason=empty when notify_user.text is blank', async () => {
      mockEngine.setNotifyUserCall('   ')

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.skip' })).toHaveLength(1)
      })

      expect((eventLog.recent({ type: 'heartbeat.skip' })[0].payload as { reason: string }).reason).toBe('empty')
    })

    it('does NOT regex-parse the AI response — STATUS-shaped text without notify_user is still skipped', async () => {
      // Old protocol response — must NOT trigger any notification under
      // the new contract. The AI must call the tool to deliver.
      mockEngine.setRawText('STATUS: CHAT_YES\nREASON: x\nCONTENT: this should NOT be delivered')
      mockEngine.setNoToolCall()

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.skip' })).toHaveLength(1)
      })

      const { entries } = await notificationsStore.read()
      expect(entries).toHaveLength(0)
    })

    it('ignores non-heartbeat cron.fire events', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await eventLog.append('cron.fire', {
        jobId: 'other-job',
        jobName: 'check-eth',
        payload: 'Check ETH price',
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== Active Hours ====================

  describe('active hours', () => {
    it('skips when outside active hours, without invoking AI', async () => {
      const fakeNow = new Date('2025-06-15T03:00:00').getTime() // 3 AM local

      heartbeat = createHeartbeat({
        config: makeConfig({
          activeHours: { start: '09:00', end: '22:00', timezone: 'local' },
        }),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
        now: () => fakeNow,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.skip' })).toHaveLength(1)
      })

      const skips = eventLog.recent({ type: 'heartbeat.skip' })
      expect((skips[0].payload as { reason: string }).reason).toBe('outside-active-hours')
      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
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
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      const jobId = cronEngine.list()[0].id

      // First fire — delivered
      await cronEngine.runNow(jobId)
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.done' })).toHaveLength(1)
      })

      // Second fire (same notify_user text) — should be deduped
      await cronEngine.runNow(jobId)
      await vi.waitFor(() => {
        const skips = eventLog.recent({ type: 'heartbeat.skip' })
        expect(skips.some((s) => (s.payload as { reason: string }).reason === 'duplicate')).toBe(true)
      })

      expect(delivered).toHaveLength(1)
    })

    it('different notify_user texts are not deduped', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      const jobId = cronEngine.list()[0].id

      mockEngine.setNotifyUserCall('First alert')
      await cronEngine.runNow(jobId)
      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      mockEngine.setNotifyUserCall('Second different alert')
      await cronEngine.runNow(jobId)
      await vi.waitFor(() => {
        expect(delivered).toHaveLength(2)
      })

      expect(delivered).toEqual(['First alert', 'Second different alert'])
    })
  })

  // ==================== Error Handling ====================

  describe('error handling', () => {
    it('emits heartbeat.error on AI failure', async () => {
      mockEngine.setShouldThrow(new Error('AI down'))

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.error' })).toHaveLength(1)
      })

      const errors = eventLog.recent({ type: 'heartbeat.error' })
      expect(errors[0].payload).toMatchObject({ error: 'AI down' })
    })

    it('handles notify failure gracefully — emits done with delivered=false', async () => {
      mockEngine.setNotifyUserCall('alert text')
      // Force the underlying append to reject. The runner should still
      // emit done with delivered=false; the listener should not crash.
      const originalAppend = notificationsStore.append.bind(notificationsStore)
      notificationsStore.append = async () => { throw new Error('store failed') }

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'heartbeat.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'heartbeat.done' })
      expect((done[0].payload as { delivered: boolean }).delivered).toBe(false)

      notificationsStore.append = originalAppend
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('stops listening after stop()', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      heartbeat.stop()

      await cronEngine.runNow(cronEngine.list()[0].id)
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== setEnabled / isEnabled ====================

  describe('setEnabled', () => {
    it('enables a previously disabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
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
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
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
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
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
        agentWorkRunner, cronEngine, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.setEnabled(true)

      await cronEngine.runNow(cronEngine.list()[0].id)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })
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
      { start: '09:00', end: '22:00', timezone: 'local' },
      ts,
    )).toBe(true)
  })

  it('returns false outside normal range', () => {
    const ts = todayAt(3, 0).getTime()
    expect(isWithinActiveHours(
      { start: '09:00', end: '22:00', timezone: 'local' },
      ts,
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

  it('exposes lastText (load-bearing for buildDonePayload)', () => {
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
