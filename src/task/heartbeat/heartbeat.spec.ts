/**
 * Heartbeat tests — Pump-driven trigger source.
 *
 * Post-Pump refactor, heartbeat no longer subscribes to cron.fire.
 * It owns a private Pump. Tests trigger ticks via `heartbeat.runNow()`
 * (which delegates to `pump.runNow()`) rather than `cronEngine.runNow()`.
 *
 * The full pipeline test path:
 *   heartbeat.runNow()
 *     → pump.runNow() → onTick
 *     → active-hours pre-filter (skip → emit agent.work.skip directly)
 *     → producer.emit('agent.work.requested') for the canonical event
 *   → agent-work-listener picks up the request
 *     → source-config-driven AgentWorkRunner.run()
 *     → notify_user inspection + dedup gate
 *     → emit agent.work.{done,skip,error}
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import {
  createHeartbeat,
  isWithinActiveHours,
  HeartbeatDedup,
  type Heartbeat,
  type HeartbeatConfig,
} from './heartbeat.js'
import { SessionStore } from '../../core/session.js'
import { ConnectorCenter } from '../../core/connector-center.js'
import { createMemoryNotificationsStore } from '../../core/notifications-store.js'
import { AgentWorkRunner } from '../../core/agent-work.js'
import { createAgentWorkListener, type AgentWorkListener } from '../../core/agent-work-listener.js'
import type { ToolCallSummary } from '../../ai-providers/types.js'
import type {
  AgentWorkDonePayload,
  AgentWorkSkipPayload,
  AgentWorkErrorPayload,
} from '../../core/agent-event.js'

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
  let heartbeat: Heartbeat
  let mockEngine: ReturnType<typeof createMockEngine>
  let session: SessionStore
  let connectorCenter: ConnectorCenter
  let notificationsStore: ReturnType<typeof createMemoryNotificationsStore>
  let agentWorkListener: AgentWorkListener

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    listenerRegistry = createListenerRegistry(eventLog)
    await listenerRegistry.start()

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
    await listenerRegistry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('start() is idempotent', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.start()  // no error
    })

    it('start() respects config.enabled', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.reason).toBe('empty')
    })

    it('does NOT regex-parse STATUS-shaped raw text — anti-regression', async () => {
      mockEngine.setRawText('STATUS: CHAT_YES\nCONTENT: should NOT be delivered')
      mockEngine.setNoToolCall()

      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const { entries } = await notificationsStore.read()
      expect(entries).toHaveLength(0)
    })

    it('no longer subscribes to cron.fire (decoupled from cron-engine)', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      // Fire a cron.fire event with the legacy __heartbeat__ jobName.
      // Pre-refactor, this would have driven heartbeat. Post-refactor,
      // heartbeat is fully decoupled — no AI call should happen.
      await eventLog.append('cron.fire', {
        jobId: 'legacy-id',
        jobName: '__heartbeat__',
        payload: 'should be ignored',
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
        agentWorkListener, registry: listenerRegistry, session,
        now: () => fakeNow,
      })
      await heartbeat.start()
      await heartbeat.runNow()

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.source).toBe('heartbeat')
      expect(skip.reason).toBe('outside-active-hours')
      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      // No agent.work.requested emitted (pre-emit gate)
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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await heartbeat.runNow()
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      await heartbeat.runNow()
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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      mockEngine.setNotifyUserCall('First alert')
      await heartbeat.runNow()
      await vi.waitFor(() => { expect(delivered).toHaveLength(1) })

      mockEngine.setNotifyUserCall('Second different alert')
      await heartbeat.runNow()
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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

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
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.delivered).toBe(false)

      notificationsStore.append = originalAppend
    })
  })

  // ==================== stop ====================

  describe('stop', () => {
    it('runNow is a no-op after stop()', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      heartbeat.stop()

      await heartbeat.runNow()
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== setEnabled ====================

  describe('setEnabled', () => {
    it('enables a previously disabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(false)

      await heartbeat.setEnabled(true)
      expect(heartbeat.isEnabled()).toBe(true)
    })

    it('disables an enabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: true }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(true)

      await heartbeat.setEnabled(false)
      expect(heartbeat.isEnabled()).toBe(false)
    })

    it('persists config via writeConfigSection', async () => {
      const { writeConfigSection } = await import('../../core/config.js')

      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.setEnabled(true)

      expect(writeConfigSection).toHaveBeenCalledWith(
        'heartbeat',
        expect.objectContaining({ enabled: true }),
      )
    })

    it('runNow ignores the enabled flag (always fires for manual trigger)', async () => {
      const delivered: string[] = []
      notificationsStore.onAppended((entry) => { delivered.push(entry.text) })

      mockEngine.setNotifyUserCall('manual-fire')

      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      // Even though enabled=false, manual runNow should still work
      await heartbeat.runNow()

      await vi.waitFor(() => { expect(delivered).toHaveLength(1) })
      expect(delivered[0]).toBe('manual-fire')
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
