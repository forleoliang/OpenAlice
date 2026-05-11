/**
 * Tests for the diary route's event-log → cycle projection.
 *
 * Post-AgentWork refactor, diary reads canonical `agent.work.*` events
 * (filtered by `source === 'heartbeat'`) instead of the old
 * `heartbeat.*` event types. These tests exercise the projection
 * functions on synthetic fixtures of the new shape.
 */

import { describe, it, expect } from 'vitest'
import {
  buildDiaryCycles,
  outcomeFromEvent,
  type DiaryOutcome,
} from '../routes/diary.js'
import type { EventLogEntry } from '../../core/event-log.js'

// ==================== Fixtures ====================

const done = (seq: number, ts: number, delivered: boolean, durationMs = 100): EventLogEntry => ({
  seq, ts, type: 'agent.work.done',
  payload: { source: 'heartbeat', reply: 'hi', durationMs, delivered },
})

const skip = (seq: number, ts: number, reason: string, parsedReason?: string): EventLogEntry => ({
  seq, ts, type: 'agent.work.skip',
  payload: parsedReason !== undefined
    ? { source: 'heartbeat', reason, metadata: { parsedReason } }
    : { source: 'heartbeat', reason },
})

const err = (seq: number, ts: number, error: string, durationMs = 50): EventLogEntry => ({
  seq, ts, type: 'agent.work.error',
  payload: { source: 'heartbeat', error, durationMs },
})

// ==================== Tests ====================

describe('outcomeFromEvent', () => {
  const cases: Array<[string, EventLogEntry, DiaryOutcome]> = [
    ['agent.work.done delivered=true → "delivered"', done(1, 0, true), 'delivered'],
    ['agent.work.done delivered=false → "silent-ok"', done(1, 0, false), 'silent-ok'],
    ['agent.work.skip reason=ack → "silent-ok"', skip(1, 0, 'ack'), 'silent-ok'],
    ['agent.work.skip reason=duplicate → "duplicate"', skip(1, 0, 'duplicate'), 'duplicate'],
    ['agent.work.skip reason=empty → "empty"', skip(1, 0, 'empty'), 'empty'],
    ['agent.work.skip reason=outside-active-hours → "outside-hours"', skip(1, 0, 'outside-active-hours'), 'outside-hours'],
    ['agent.work.skip unknown reason → "silent-ok"', skip(1, 0, 'something-else'), 'silent-ok'],
    ['agent.work.error → "error"', err(1, 0, 'boom'), 'error'],
  ]
  for (const [label, entry, expected] of cases) {
    it(label, () => expect(outcomeFromEvent(entry)).toBe(expected))
  }

  it('returns "silent-ok" for unknown event types (defensive default)', () => {
    expect(outcomeFromEvent({ seq: 1, ts: 0, type: 'some.other.event', payload: {} })).toBe('silent-ok')
  })
})

describe('buildDiaryCycles', () => {
  it('surfaces error message as reason for agent.work.error', () => {
    const cycles = buildDiaryCycles([err(5, 1000, 'network timeout', 250)])
    expect(cycles[0]).toMatchObject({
      seq: 5,
      ts: 1000,
      outcome: 'error',
      reason: 'network timeout',
      durationMs: 250,
    })
  })

  it('prefers parsedReason (metadata) over machine reason for skip events', () => {
    // parsedReason is heartbeat's truncated notify_user text on duplicate
    // skips — more useful to show humans than the machine code "duplicate".
    const cycles = buildDiaryCycles([skip(5, 1000, 'duplicate', 'market is quiet, watching for a breakout')])
    expect(cycles[0].reason).toBe('market is quiet, watching for a breakout')
  })

  it('falls back to reason when parsedReason is missing', () => {
    const cycles = buildDiaryCycles([skip(5, 1000, 'duplicate')])
    expect(cycles[0].reason).toBe('duplicate')
  })

  it('preserves input ordering (caller is responsible for sorting)', () => {
    const cycles = buildDiaryCycles([
      done(3, 3000, true),
      skip(1, 1000, 'ack'),
      err(2, 2000, 'boom'),
    ])
    expect(cycles.map((c) => c.seq)).toEqual([3, 1, 2])
  })

  it('includes durationMs for done and error, omits for skip', () => {
    const cycles = buildDiaryCycles([
      done(1, 0, true, 150),
      skip(2, 0, 'ack'),
      err(3, 0, 'oops', 42),
    ])
    expect(cycles[0].durationMs).toBe(150)
    expect(cycles[1].durationMs).toBeUndefined()
    expect(cycles[2].durationMs).toBe(42)
  })

  it('done events have no source-specific reason in the canonical payload', () => {
    // Unlike the old heartbeat.done which carried a `reason` field, the
    // canonical agent.work.done only has source/reply/durationMs/delivered.
    // A done cycle therefore has no `reason` in the projected output.
    const cycles = buildDiaryCycles([done(1, 0, true, 100)])
    expect(cycles[0].reason).toBeUndefined()
  })
})
