/**
 * Simulator dev tab — manual control panel for MockBroker UTAs.
 *
 * Lets you drive scenarios that real exchanges produce on their own:
 *  - Move markPrice (auto-fills any limit/stop orders that the new price
 *    crosses)
 *  - Manually fill or cancel a pending order
 *  - Inject "external" events (deposit, withdraw, off-platform trade) so
 *    the UTA reconcile pipeline kicks in just like it would on a real
 *    spot exchange where balance changes outside Alice's order log.
 *
 * After any action, the state panel auto-refreshes; you can also flip to
 * the Portfolio tab to see how the changes propagate through UTA
 * reconcile + cost-basis projection.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Section } from '../components/form'
import { Spinner } from '../components/StateViews'
import { useToast } from '../components/Toast'
import {
  simulatorApi,
  type SimulatorState,
  type SimulatorUTAEntry,
} from '../api/simulator'
import { api } from '../api'

const POLL_INTERVAL_MS = 3000

const inputClass =
  'w-full px-2 py-1 bg-bg text-text border border-border rounded font-mono text-xs outline-none transition-colors focus:border-accent'

export function SimulatorPage() {
  const [utas, setUtas] = useState<SimulatorUTAEntry[]>([])
  const [selected, setSelected] = useState<string>('')
  const [state, setState] = useState<SimulatorState | null>(null)
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const refreshUtaList = useCallback(async () => {
    try {
      const r = await simulatorApi.listUtas()
      setUtas(r.utas)
      // If currently selected vanished, fall back to first
      if (r.utas.length > 0 && !r.utas.some(u => u.id === selected)) setSelected(r.utas[0].id)
      else if (r.utas.length === 0) setSelected('')
      return r.utas
    } catch (err) {
      toast.error(`Failed to list simulators: ${err instanceof Error ? err.message : err}`)
      return []
    }
  }, [selected, toast])

  // Load UTA list once on mount
  useEffect(() => {
    refreshUtaList()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = useCallback(async () => {
    if (!selected) return
    try {
      const s = await simulatorApi.state(selected)
      setState(s)
    } catch (err) {
      toast.error(`State fetch failed: ${err instanceof Error ? err.message : err}`)
      setState(null)
    }
  }, [selected, toast])

  // Refresh on selection change + poll
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Wrapper that runs an action and refreshes state on success.
  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    if (!selected) return
    setLoading(true)
    try {
      await fn()
      toast.success(label)
      await refresh()
    } catch (err) {
      toast.error(`${label} failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [selected, toast, refresh])

  return (
    <div className="px-4 md:px-6 py-5 max-w-[1200px] space-y-5">
      {/* Top bar: account picker + cash + create button */}
      <div className="flex items-center gap-3 flex-wrap">
        {utas.length === 0 ? (
          <span className="text-sm text-text-muted">No simulator account yet.</span>
        ) : (
          <>
            <label className="text-[12px] text-text-muted uppercase tracking-wide">Account</label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="px-2.5 py-1 bg-bg text-text border border-border rounded text-sm outline-none focus:border-accent min-w-[260px]"
            >
              {utas.map(u => <option key={u.id} value={u.id}>{u.label} ({u.id})</option>)}
            </select>
            <button
              onClick={refresh}
              className="px-2.5 py-1 text-xs bg-bg-tertiary text-text-muted rounded hover:text-text transition-colors"
            >
              Refresh
            </button>
            {state && (
              <span className="ml-auto text-[12px] text-text-muted uppercase tracking-wide">
                Cash <span className="font-mono text-text text-sm normal-case ml-1.5">
                  ${Number(state.cash).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </span>
            )}
          </>
        )}
      </div>

      <CreateSimulatorSection
        onCreated={async (newId) => {
          const list = await refreshUtaList()
          if (list.some(u => u.id === newId)) setSelected(newId)
        }}
      />

      {selected && (state ? (
        <>
          {/* Two-column row: prices on left (drives the simulation), positions on right (where you watch the result). Action and observation paired side by side. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            <MarkPricesSection
              utaId={selected}
              state={state}
              run={run}
              loading={loading}
            />
            <PositionsSection state={state} />
          </div>

          <PendingOrdersSection
            utaId={selected}
            state={state}
            run={run}
            loading={loading}
          />

          <ExternalEventsSection
            utaId={selected}
            state={state}
            run={run}
            loading={loading}
          />
        </>
      ) : (
        <div className="flex justify-center py-12"><Spinner /></div>
      ))}
    </div>
  )
}

// ==================== Create Simulator UTA ====================

function CreateSimulatorSection({ onCreated }: {
  onCreated: (id: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [cash, setCash] = useState('100000')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const submit = async () => {
    const cashNum = Number(cash)
    if (!Number.isFinite(cashNum) || cashNum < 0) {
      toast.error('Cash must be a non-negative number')
      return
    }
    setBusy(true)
    try {
      const finalLabel = name.trim() || 'simulator'
      // Server derives id from preset.fingerprintFields (= ['_instanceId']
      // for Mock); a fresh _instanceId is minted server-side when missing,
      // so each create lands on a distinct id.
      const created = await api.trading.createUTA({
        label: finalLabel,
        presetId: 'mock-simulator',
        enabled: true,
        guards: [],
        presetConfig: { cash: cashNum },
      })
      await api.trading.reconnectUTA(created.id).catch(() => {})
      toast.success(`Created ${created.label} (${created.id})`)
      setOpen(false)
      setName('')
      setCash('100000')
      await onCreated(created.id)
    } catch (err) {
      toast.error(`Create failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary-sm"
      >
        + New simulator account
      </button>
    )
  }

  return (
    <Section
      title="Create simulator account"
      description="In-memory only — wiped on dev server restart. For repro & regression testing."
    >
      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="px-2 py-1 bg-bg text-text border border-border rounded text-sm outline-none transition-colors focus:border-accent w-48"
          placeholder="name (e.g. simulator)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="px-2 py-1 bg-bg text-text border border-border rounded font-mono text-xs outline-none transition-colors focus:border-accent w-32"
          placeholder="cash (USD)"
          value={cash}
          onChange={(e) => setCash(e.target.value)}
        />
        <button disabled={busy} onClick={submit} className="btn-primary-sm">
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          disabled={busy}
          onClick={() => { setOpen(false); setName(''); setCash('100000') }}
          className="btn-secondary-sm"
        >
          Cancel
        </button>
      </div>
    </Section>
  )
}

// ==================== Mark Prices ====================

function MarkPricesSection({ utaId, state, run, loading }: {
  utaId: string
  state: SimulatorState
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>
  loading: boolean
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newKey, setNewKey] = useState('')
  const [newPrice, setNewPrice] = useState('')

  // Sync drafts with incoming state, preserving any in-flight user edits.
  // A "no draft for key" → input shows current state.price; once the user
  // types, the draft for that key holds their typed value until they
  // commit (Set/Tick) or some other code path explicitly clears it.
  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, string> = {}
      for (const m of state.markPrices) {
        if (prev[m.nativeKey] !== undefined) next[m.nativeKey] = prev[m.nativeKey]
      }
      return next
    })
  }, [state.markPrices])

  // After a successful action on `key`, drop its draft so the input
  // re-syncs to the freshly-fetched state.price on the next render.
  const dropDraft = (key: string) => setDrafts((d) => {
    const next = { ...d }
    delete next[key]
    return next
  })

  return (
    <Section
      title="Mark Prices"
      description="Per-symbol mark price. Editing or ticking auto-matches any pending limit/stop order whose trigger the new price crosses."
    >
      <div className="space-y-1">
        {state.markPrices.length === 0 ? (
          <p className="text-xs text-text-muted">No prices set yet — add one below.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted text-xs">
                <th className="pb-1 pr-3">Native Key</th>
                <th className="pb-1 pr-3 w-40">Price</th>
                <th className="pb-1 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.markPrices.map((m) => (
                <tr key={m.nativeKey} className="text-text">
                  <td className="py-1 pr-3 font-mono text-xs">{m.nativeKey}</td>
                  <td className="py-1 pr-3">
                    <input
                      className={inputClass}
                      value={drafts[m.nativeKey] ?? m.price}
                      onChange={(e) => setDrafts({ ...drafts, [m.nativeKey]: e.target.value })}
                    />
                  </td>
                  <td className="py-1 text-right space-x-1">
                    <button
                      disabled={loading}
                      onClick={() => run(
                        `Set ${m.nativeKey} = ${drafts[m.nativeKey] ?? m.price}`,
                        async () => {
                          await simulatorApi.setMarkPrice(utaId, m.nativeKey, drafts[m.nativeKey] ?? m.price)
                          dropDraft(m.nativeKey)
                        },
                      )}
                      className="btn-secondary-xs"
                    >Set</button>
                    <button
                      disabled={loading}
                      onClick={() => run(`${m.nativeKey} −1%`, async () => {
                        await simulatorApi.tickPrice(utaId, m.nativeKey, -1)
                        dropDraft(m.nativeKey)
                      })}
                      className="btn-secondary-xs"
                    >−1%</button>
                    <button
                      disabled={loading}
                      onClick={() => run(`${m.nativeKey} +1%`, async () => {
                        await simulatorApi.tickPrice(utaId, m.nativeKey, 1)
                        dropDraft(m.nativeKey)
                      })}
                      className="btn-secondary-xs"
                    >+1%</button>
                    <button
                      disabled={loading}
                      onClick={() => run(`${m.nativeKey} +5%`, async () => {
                        await simulatorApi.tickPrice(utaId, m.nativeKey, 5)
                        dropDraft(m.nativeKey)
                      })}
                      className="btn-secondary-xs"
                    >+5%</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="flex items-center gap-2 pt-3 border-t border-border">
          <input
            className={`${inputClass} w-44`}
            placeholder="native key (e.g. BTC)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.trim())}
          />
          <input
            className={`${inputClass} w-32`}
            placeholder="price"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
          />
          <button
            disabled={loading || !newKey || !newPrice}
            onClick={() => run(
              `Add ${newKey} = ${newPrice}`,
              async () => {
                await simulatorApi.setMarkPrice(utaId, newKey, newPrice)
                setNewKey('')
                setNewPrice('')
              },
            )}
            className="btn-primary-sm"
          >Add</button>
        </div>
      </div>
    </Section>
  )
}

// ==================== Pending Orders ====================

function PendingOrdersSection({ utaId, state, run, loading }: {
  utaId: string
  state: SimulatorState
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>
  loading: boolean
}) {
  const [fillForms, setFillForms] = useState<Record<string, { price: string; qty: string }>>({})
  const updateForm = (id: string, field: 'price' | 'qty', value: string) => {
    setFillForms({ ...fillForms, [id]: { ...(fillForms[id] ?? { price: '', qty: '' }), [field]: value } })
  }

  return (
    <Section
      title="Pending Orders"
      description="Submitted limit/stop orders waiting on a price trigger or manual fill."
    >
      {state.pendingOrders.length === 0 ? (
        <p className="text-xs text-text-muted">No pending orders.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted text-xs">
              <th className="pb-1 pr-3">Order</th>
              <th className="pb-1 pr-3">Symbol</th>
              <th className="pb-1 pr-3">Side</th>
              <th className="pb-1 pr-3">Type</th>
              <th className="pb-1 pr-3">Qty</th>
              <th className="pb-1 pr-3">Trigger</th>
              <th className="pb-1 pr-3 w-40">Fill price (opt)</th>
              <th className="pb-1 pr-3 w-32">Fill qty (opt)</th>
              <th className="pb-1 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.pendingOrders.map((o) => {
              const form = fillForms[o.orderId] ?? { price: '', qty: '' }
              const trigger = o.lmtPrice ?? o.auxPrice ?? '—'
              return (
                <tr key={o.orderId} className="text-text">
                  <td className="py-1 pr-3 font-mono text-[11px]">{o.orderId}</td>
                  <td className="py-1 pr-3">{o.symbol}</td>
                  <td className="py-1 pr-3">{o.action}</td>
                  <td className="py-1 pr-3">{o.orderType}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{o.totalQuantity}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{trigger}</td>
                  <td className="py-1 pr-3">
                    <input
                      className={inputClass}
                      placeholder="markPrice"
                      value={form.price}
                      onChange={(e) => updateForm(o.orderId, 'price', e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <input
                      className={inputClass}
                      placeholder="full"
                      value={form.qty}
                      onChange={(e) => updateForm(o.orderId, 'qty', e.target.value)}
                    />
                  </td>
                  <td className="py-1 text-right space-x-1">
                    <button
                      disabled={loading}
                      onClick={() => run(
                        `Fill ${o.orderId}`,
                        () => simulatorApi.fillOrder(utaId, o.orderId, {
                          ...(form.price && { price: form.price }),
                          ...(form.qty && { qty: form.qty }),
                        }),
                      )}
                      className="btn-secondary-xs"
                    >Fill</button>
                    <button
                      disabled={loading}
                      onClick={() => run(`Cancel ${o.orderId}`, () => simulatorApi.cancelOrder(utaId, o.orderId))}
                      className="btn-secondary-xs"
                    >Cancel</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Section>
  )
}

// ==================== Positions ====================

function PositionsSection({ state }: { state: SimulatorState }) {
  // Pre-index markPrices so the PnL column reads in O(1) per row.
  const markByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const mp of state.markPrices) m.set(mp.nativeKey, mp.price)
    return m
  }, [state.markPrices])

  return (
    <Section
      title="Positions"
      description="Read-only — mutate via mark price moves, order fills, or external events."
    >
      {state.positions.length === 0 ? (
        <p className="text-xs text-text-muted">No positions.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted text-xs">
              <th className="pb-1 pr-3">Position</th>
              <th className="pb-1 pr-3 text-right">Qty</th>
              <th className="pb-1 pr-3 text-right">Avg Cost</th>
              <th className="pb-1 pr-3 text-right">Mark</th>
              <th className="pb-1 text-right">PnL</th>
            </tr>
          </thead>
          <tbody>
            {state.positions.map((p) => {
              const mark = markByKey.get(p.nativeKey)
              const qty = Number(p.quantity)
              const avg = Number(p.avgCost)
              const pnl = mark && Number.isFinite(qty) && Number.isFinite(avg)
                ? (Number(mark) - avg) * qty * (p.side === 'long' ? 1 : -1)
                : null
              const pnlClass = pnl == null ? 'text-text-muted' : pnl > 0 ? 'text-green' : pnl < 0 ? 'text-red' : 'text-text'
              return (
                <tr key={p.nativeKey} className="text-text">
                  <td className="py-1 pr-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-xs">{p.nativeKey}</span>
                      {p.secType && (
                        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-bg-tertiary text-text-muted/80">{p.secType}</span>
                      )}
                      <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${p.side === 'long' ? 'bg-green/15 text-green' : 'bg-red/15 text-red'}`}>
                        {p.side}
                      </span>
                      {p.avgCostSource === 'wallet' && (
                        <span className="text-[9px] text-text-muted/60" title="Cost basis derived from UTA reconcile pipeline (wallet-source position)">wallet</span>
                      )}
                    </div>
                  </td>
                  <td className="py-1 pr-3 font-mono text-xs text-right">{p.quantity}</td>
                  <td className="py-1 pr-3 font-mono text-xs text-right">{p.avgCost}</td>
                  <td className="py-1 pr-3 font-mono text-xs text-right text-text-muted">{mark ?? '—'}</td>
                  <td className={`py-1 font-mono text-xs text-right ${pnlClass}`}>
                    {pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Section>
  )
}

// ==================== External Events ====================

function ExternalEventsSection({ utaId, state, run, loading }: {
  utaId: string
  state: SimulatorState
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>
  loading: boolean
}) {
  const [mode, setMode] = useState<'deposit' | 'withdraw' | 'trade'>('deposit')
  const [nativeKey, setNativeKey] = useState('')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [secType, setSecType] = useState<'CRYPTO' | 'CRYPTO_PERP' | 'STK'>('CRYPTO')

  const knownKeys = useMemo(() => {
    const set = new Set<string>()
    for (const m of state.markPrices) set.add(m.nativeKey)
    for (const p of state.positions) set.add(p.nativeKey)
    return [...set].sort()
  }, [state])

  const submit = () => {
    if (!nativeKey || !quantity) return
    if (mode === 'deposit') {
      run(
        `Deposit ${quantity} ${nativeKey}`,
        () => simulatorApi.externalDeposit(utaId, {
          nativeKey,
          quantity,
          contract: { symbol: nativeKey, secType },
        }),
      )
    } else if (mode === 'withdraw') {
      run(`Withdraw ${quantity} ${nativeKey}`, () => simulatorApi.externalWithdraw(utaId, nativeKey, quantity))
    } else {
      if (!price) return
      run(
        `External ${side} ${quantity} ${nativeKey} @ ${price}`,
        () => simulatorApi.externalTrade(utaId, {
          nativeKey,
          side,
          quantity,
          price,
          contract: { symbol: nativeKey, secType },
        }),
      )
    }
  }

  return (
    <Section
      title="External Events"
      description="Simulate balance changes Alice didn't initiate (airdrop, transfer-in, off-platform trade) — exercises the UTA reconcile pipeline."
    >
      <div className="flex items-center gap-2 mb-3">
        {(['deposit', 'withdraw', 'trade'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${mode === m ? 'bg-accent/20 text-accent font-medium' : 'bg-bg-tertiary text-text-muted hover:text-text'}`}
          >{m}</button>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          className={`${inputClass} w-44`}
          placeholder="native key"
          value={nativeKey}
          onChange={(e) => setNativeKey(e.target.value.trim())}
          list="sim-known-keys"
        />
        <datalist id="sim-known-keys">
          {knownKeys.map(k => <option key={k} value={k} />)}
        </datalist>

        <input
          className={`${inputClass} w-28`}
          placeholder="quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />

        {mode === 'trade' && (
          <>
            <input
              className={`${inputClass} w-28`}
              placeholder="price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}
              className={`${inputClass} w-20`}
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </>
        )}

        {(mode === 'deposit' || mode === 'trade') && (
          <select
            value={secType}
            onChange={(e) => setSecType(e.target.value as 'CRYPTO' | 'CRYPTO_PERP' | 'STK')}
            className={`${inputClass} w-32`}
          >
            <option value="CRYPTO">CRYPTO</option>
            <option value="CRYPTO_PERP">CRYPTO_PERP</option>
            <option value="STK">STK</option>
          </select>
        )}

        <button
          disabled={loading || !nativeKey || !quantity || (mode === 'trade' && !price)}
          onClick={submit}
          className="btn-primary-sm"
        >Submit</button>
      </div>

      <p className="text-[11px] text-text-muted mt-2">
        Deposit / withdraw don't change cash. External trade decreases cash on BUY, increases on SELL — like the user manually executed on the exchange app.
      </p>
    </Section>
  )
}
