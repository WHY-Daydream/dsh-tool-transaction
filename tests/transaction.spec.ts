/**
 * Behavior suite for the dsh-tool-transaction Saga service: commit,
 * failure-driven rollback with reverse-order compensation, compensation
 * failure yielding ROLLBACK_PARTIAL, lifecycle event ordering, effect
 * classification policy (irreversible deny, read-only contradiction), and
 * fail-loud config validation — all driven through a real cordis Context.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Transaction from '../src/index.ts'
import type { Config, TransactionEventData } from '../src/index.ts'

/** Boot a context with the transaction service registered. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Transaction, config)
  return ctx
}

/** Collect lifecycle events in arrival order. */
function recordEvents(ctx: Context): TransactionEventData[] {
  const events: TransactionEventData[] = []
  for (const event of [
    'transaction/start',
    'transaction/step-start',
    'transaction/step-committed',
    'transaction/step-failed',
    'transaction/rollback-start',
    'transaction/compensation-start',
    'transaction/compensation-done',
    'transaction/compensation-failed',
    'transaction/rollback-end',
    'transaction/committed',
  ] as const) {
    ctx.on(event, (data: TransactionEventData) => events.push({ ...data }))
  }
  return events
}

describe('transaction commit', () => {
  it('executes steps in order and ends COMMITTED without compensation', async () => {
    const ctx = await harness()
    const events = recordEvents(ctx)
    const tx = ctx.transaction.begin()

    const step = (name: string) => ({
      name,
      execute: async () => { return { id: name } },
      compensate: async () => { throw new Error(`should not compensate ${name}`) },
    })

    const a = await tx.step(step('a'))
    const b = await tx.step(step('b'))
    await tx.commit()

    expect(a).toEqual({ id: 'a' })
    expect(b).toEqual({ id: 'b' })
    expect(tx.state).toBe('COMMITTED')
    // each step emits step-start + step-committed, both carrying the step name
    expect(events.filter(e => e.step !== undefined).map(e => e.step)).toEqual(['a', 'a', 'b', 'b'])
  })

  it('forbids adding a step after commit', async () => {
    const ctx = await harness()
    const tx = ctx.transaction.begin()
    await tx.step({ name: 'a', execute: async () => undefined })
    await tx.commit()
    await expect(tx.step({ name: 'b', execute: async () => undefined })).rejects.toThrow(/settled/)
  })
})

describe('rollback with reverse-order compensation', () => {
  it('compensates committed steps in reverse order on step failure', async () => {
    const ctx = await harness()
    const events = recordEvents(ctx)
    const order: string[] = []
    const tx = ctx.transaction.begin()

    await tx.step({
      name: 'create_order',
      execute: async () => { order.push('create_order') ; return { id: 1 } },
      compensate: async () => { order.push('cancel_order') },
    })
    await tx.step({
      name: 'reserve_inventory',
      execute: async () => { order.push('reserve_inventory') ; return { id: 2 } },
      compensate: async () => { order.push('release_inventory') },
    })
    await expect(tx.step({
      name: 'charge_payment',
      execute: async () => { order.push('charge_payment') ; throw new Error('payment declined') },
      compensate: async () => { order.push('refund_payment') },
    })).rejects.toThrow('payment declined')

    // Saga semantics: a failed step reports itself; the caller decides to roll
    // back, which then compensates the committed steps in reverse order.
    await tx.rollback()

    expect(order).toEqual([
      'create_order', 'reserve_inventory', 'charge_payment',
      'release_inventory', 'cancel_order', // LIFO: B then A
    ])
    expect(tx.state).toBe('ROLLED_BACK')
    const steps = events.filter(e => e.step !== undefined)
    // every step-carrying event: step-start+step-committed (×2 committed steps),
    // step-start+step-failed (failed step), compensation-start+compensation-done
    // (×2 compensated steps) — all in arrival order
    expect(steps.map(e => e.step)).toEqual([
      'create_order', 'create_order',
      'reserve_inventory', 'reserve_inventory',
      'charge_payment', 'charge_payment',
      'reserve_inventory', 'reserve_inventory',
      'create_order', 'create_order',
    ])
    expect(steps.some(e => e.error !== undefined)).toBe(true)
  })

  it('explicit rollback() compensates reverse order and ends ROLLED_BACK', async () => {
    const ctx = await harness()
    const order: string[] = []
    const tx = ctx.transaction.begin()
    await tx.step({ name: 'x', execute: async () => undefined, compensate: async () => { order.push('undo-x') } })
    await tx.step({ name: 'y', execute: async () => undefined, compensate: async () => { order.push('undo-y') } })
    await tx.rollback()
    expect(order).toEqual(['undo-y', 'undo-x'])
    expect(tx.state).toBe('ROLLED_BACK')
  })

  it('skips steps without compensate during rollback', async () => {
    const ctx = await harness()
    const tx = ctx.transaction.begin()
    await tx.step({ name: 'read_only', execute: async () => undefined })
    await tx.step({ name: 'write', execute: async () => undefined, compensate: async () => undefined })
    await tx.rollback()
    expect(tx.state).toBe('ROLLED_BACK')
  })
})

describe('compensation failure', () => {
  it('yields ROLLBACK_PARTIAL while still compensating the remaining steps', async () => {
    const ctx = await harness()
    const events = recordEvents(ctx)
    const order: string[] = []
    const tx = ctx.transaction.begin()

    await tx.step({
      name: 'a', execute: async () => undefined,
      compensate: async () => { order.push('undo-a') ; throw new Error('a-compensation lost') },
    })
    await tx.step({
      name: 'b', execute: async () => undefined,
      compensate: async () => { order.push('undo-b') },
    })

    await tx.rollback()

    // LIFO: b compensates first (success), then a fails → PARTIAL
    expect(order).toEqual(['undo-b', 'undo-a'])
    expect(tx.state).toBe('ROLLBACK_PARTIAL')
    const failed = events.filter(e => e.step === 'a' && e.error !== undefined)
    expect(failed).toHaveLength(1)
    const end = events.find(e => e.step === undefined && e.state !== undefined)
    expect(end?.state).toBe('ROLLBACK_PARTIAL')
  })
})

describe('lifecycle event ordering', () => {
  it('emits the full saga sequence for a failing transaction', async () => {
    const ctx = await harness()
    const types: string[] = []
    for (const event of [
      'transaction/start', 'transaction/step-start', 'transaction/step-committed',
      'transaction/step-failed', 'transaction/rollback-start',
      'transaction/compensation-start', 'transaction/compensation-done',
      'transaction/compensation-failed', 'transaction/rollback-end', 'transaction/committed',
    ] as const) {
      ctx.on(event, () => types.push(event))
    }
    const tx = ctx.transaction.begin()
    await tx.step({ name: 'a', execute: async () => undefined, compensate: async () => undefined })
    await expect(tx.step({
      name: 'b', execute: async () => { throw new Error('boom') },
      compensate: async () => undefined,
    })).rejects.toThrow('boom')
    await tx.rollback()

    expect(types).toEqual([
      'transaction/start',
      'transaction/step-start', 'transaction/step-committed',
      'transaction/step-start', 'transaction/step-failed',
      'transaction/rollback-start',
      'transaction/compensation-start', 'transaction/compensation-done',
      'transaction/rollback-end',
    ])
  })

  it('emits transaction/committed on success', async () => {
    const ctx = await harness()
    const types: string[] = []
    ctx.on('transaction/committed', () => types.push('committed'))
    const tx = ctx.transaction.begin()
    await tx.step({ name: 'a', execute: async () => undefined })
    await tx.commit()
    expect(types).toEqual(['committed'])
  })
})

describe('effect classification policy', () => {
  it('denies irreversible steps at join time', async () => {
    const ctx = await harness({ effects: { send_email: 'irreversible' } })
    const tx = ctx.transaction.begin()
    await expect(tx.step({
      name: 'send_email', execute: async () => undefined, compensate: async () => undefined,
    })).rejects.toThrow(/irreversible/)
    expect(tx.state).toBe('ACTIVE')
  })

  it('rejects a read-only step that declares compensation', async () => {
    const ctx = await harness({ effects: { read_file: 'read-only' } })
    const tx = ctx.transaction.begin()
    await expect(tx.step({
      name: 'read_file', execute: async () => undefined, compensate: async () => undefined,
    })).rejects.toThrow(/read-only/)
  })

  it('rejects invalid effect classifications at load time', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(Transaction, { effects: { web_search: 'magic' } }))
      .rejects.toThrow(/invalid effect/)
  })

  it('defaults an unconfigured step with compensate to compensatable', async () => {
    const ctx = await harness()
    const tx = ctx.transaction.begin()
    await tx.step({ name: 'reserve', execute: async () => undefined, compensate: async () => undefined })
    await tx.rollback()
    expect(tx.state).toBe('ROLLED_BACK')
  })
})

describe('convenience runner', () => {
  it('run() commits when every step succeeds', async () => {
    const ctx = await harness()
    const tx = await ctx.transaction.run([
      { name: 'a', execute: async () => undefined },
      { name: 'b', execute: async () => undefined, compensate: async () => undefined },
    ])
    expect(tx.state).toBe('COMMITTED')
  })

  it('run() rolls back in reverse order and rethrows on failure', async () => {
    const ctx = await harness()
    const order: string[] = []
    await expect(ctx.transaction.run([
      { name: 'a', execute: async () => { order.push('a') }, compensate: async () => { order.push('undo-a') } },
      { name: 'b', execute: async () => { order.push('b') }, compensate: async () => { order.push('undo-b') } },
      { name: 'c', execute: async () => { order.push('c') ; throw new Error('fail') }, compensate: async () => { order.push('undo-c') } },
    ])).rejects.toThrow('fail')
    expect(order).toEqual(['a', 'b', 'c', 'undo-b', 'undo-a'])
  })
})
