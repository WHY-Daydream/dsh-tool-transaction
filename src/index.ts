/**
 * Saga-style compensating transactions for DeepSeek Harness.
 * Registers a `ctx.transaction` capability service: transactional step
 * execution with reverse-order compensation. Consumers (tools, workflows,
 * other plugins) begin a transaction, add named steps with `execute` +
 * `compensate`, then commit or roll back.
 *
 * This is NOT distributed ACID: it is a Saga-style compensating transaction —
 * compensation is best-effort, and a failed compensation yields
 * `ROLLBACK_PARTIAL` with per-step lifecycle events for manual resolution.
 *
 * @module @why-daydream/dsh-tool-transaction
 */

import { Service, type Context, type Events } from '@deepseek-ai/cordis'

export const name = 'tool-transaction'

/** Plugin config: per-tool effect classification. */
export interface Config {
  /**
   * Per-tool effect classification. Tools not listed default to
   * `compensatable` when a `compensate` is provided and `reversible` when the
   * step declares no compensation. `irreversible` steps are denied at
   * step-join time by default policy.
   */
  effects?: Record<string, ToolEffect>
}

/** Side-effect classification of a tool. */
export type ToolEffect = 'read-only' | 'reversible' | 'compensatable' | 'irreversible'

const EFFECT_VALUES: ReadonlySet<string> = new Set(['read-only', 'reversible', 'compensatable', 'irreversible'])

/**
 * Fail-loud validation of the plugin config: every configured effect value
 * must be a known classification, and only tools named in the config are
 * classified. Throws at plugin load on invalid entries.
 * @param config - plugin config to validate.
 */
export function validateConfig(config: Config | undefined): void {
  for (const [toolName, effect] of Object.entries(config?.effects ?? {})) {
    if (!EFFECT_VALUES.has(effect)) {
      throw new Error(
        `dsh-tool-transaction: invalid effect ${JSON.stringify(effect)} for tool ${JSON.stringify(toolName)}; `
        + `expected one of ${[...EFFECT_VALUES].join(', ')}`,
      )
    }
  }
}

/** Transaction lifecycle state. */
export type TransactionState = 'ACTIVE' | 'COMMITTED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ROLLBACK_PARTIAL'

/** Lifecycle event payload shared by every `transaction/*` event. */
export interface TransactionEventData {
  /** Monotonic transaction id. */
  readonly id: number
  /** Step name when the event concerns one step. */
  readonly step?: string
  /** Error that failed a step or compensation. */
  readonly error?: unknown
  /** Final state carried by `transaction/rollback-end`. */
  readonly state?: Exclude<TransactionState, 'ACTIVE' | 'ROLLING_BACK'>
}

/** Event names emitted by this plugin, for `ctx.emit<K extends keyof Events>`. */
export type TransactionEvent =
  | 'transaction/start'
  | 'transaction/step-start'
  | 'transaction/step-committed'
  | 'transaction/step-failed'
  | 'transaction/rollback-start'
  | 'transaction/compensation-start'
  | 'transaction/compensation-done'
  | 'transaction/compensation-failed'
  | 'transaction/rollback-end'
  | 'transaction/committed'

/**
 * One transactional step. `execute` produces a receipt; `compensate` undoes
 * the side effect and receives that step's own receipt. Compensation runs in
 * reverse order of committed steps.
 */
export interface TransactionStep<TReceipt = unknown> {
  /** Stable step name, used in lifecycle events and logs. */
  readonly name: string
  /** Run the side-effectful operation; its return value is the receipt. */
  execute(): Promise<TReceipt>
  /** Undo the side effect of `execute`'s receipt. Optional for reversible/read-only steps. */
  compensate?(receipt: TReceipt): Promise<void>
}

/**
 * A running transaction: add steps, then commit or roll back.
 * After `commit()` or `rollback()` settles, the transaction is closed and no
 * further steps may be added.
 */
export interface Transaction {
  /** Monotonic transaction id for logs and event correlation. */
  readonly id: number
  /** Current lifecycle state. */
  readonly state: TransactionState
  /** Execute one step and record its receipt for reverse-order compensation. */
  step<TReceipt = unknown>(step: TransactionStep<TReceipt>): Promise<TReceipt>
  /** Commit: every added step stays; marks the transaction COMMITTED. */
  commit(): Promise<void>
  /** Roll back: compensate committed steps in reverse order. */
  rollback(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    transaction: TransactionService
  }

  interface Events {
    'transaction/start'(data: TransactionEventData): void
    'transaction/step-start'(data: TransactionEventData): void
    'transaction/step-committed'(data: TransactionEventData): void
    'transaction/step-failed'(data: TransactionEventData): void
    'transaction/rollback-start'(data: TransactionEventData): void
    'transaction/compensation-start'(data: TransactionEventData): void
    'transaction/compensation-done'(data: TransactionEventData): void
    'transaction/compensation-failed'(data: TransactionEventData): void
    'transaction/rollback-end'(data: TransactionEventData): void
    'transaction/committed'(data: TransactionEventData): void
  }
}

/** Internal record of one committed step awaiting potential compensation. */
interface CommittedStep {
  readonly name: string
  readonly compensate?: (receipt: unknown) => Promise<void>
  readonly receipt: unknown
}

/**
 * Cordis service exposing Saga-style transactions on `ctx.transaction`.
 * The service itself is stateless; each `begin()` creates an isolated
 * transaction with its own step log and lifecycle state.
 */
export class TransactionService extends Service {
  private nextId = 1

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'transaction')
  }

  /**
   * Open a new transaction. The returned handle is the only way to add steps
   * or settle the transaction; two transactions never share step state.
   * @returns a fresh ACTIVE transaction.
   */
  begin(): Transaction {
    const id = this.nextId++
    const steps: CommittedStep[] = []
    let state: TransactionState = 'ACTIVE'
    let settled = false
    const emit = (event: TransactionEvent, ...args: Parameters<Events[TransactionEvent]>): void => {
      this.ctx.emit(event, ...args)
    }

    emit('transaction/start', { id })

    const assertActive = (action: string): void => {
      if (settled) throw new Error(`dsh-tool-transaction: cannot ${action} a settled transaction #${id}`)
      if (state !== 'ACTIVE') {
        throw new Error(`dsh-tool-transaction: cannot ${action} transaction #${id} in state ${state}`)
      }
    }

    const effectOf = (step: TransactionStep): ToolEffect => {
      const configured = this.config.effects?.[step.name]
      if (configured !== undefined) return configured
      return step.compensate === undefined ? 'reversible' : 'compensatable'
    }

    return {
      get id(): number { return id },
      get state(): TransactionState { return state },

      async step<TReceipt = unknown>(step: TransactionStep<TReceipt>): Promise<TReceipt> {
        assertActive('add a step to')
        const effect = effectOf(step)
        if (effect === 'irreversible') {
          throw new Error(
            `dsh-tool-transaction: step \`${step.name}\` is classified irreversible and cannot join transaction #${id}`,
          )
        }
        if (effect === 'read-only' && step.compensate !== undefined) {
          throw new Error(
            `dsh-tool-transaction: step \`${step.name}\` is classified read-only but declares a compensate — `
            + 'read-only steps have no side effects to undo',
          )
        }
        emit('transaction/step-start', { id, step: step.name })
        let receipt: TReceipt
        try {
          receipt = await step.execute()
        } catch (error) {
          emit('transaction/step-failed', { id, step: step.name, error })
          throw error
        }
        steps.push({
          name: step.name,
          ...(step.compensate === undefined
            ? {}
            : { compensate: (value: unknown) => step.compensate!(value as TReceipt) }),
          receipt: receipt as unknown,
        })
        emit('transaction/step-committed', { id, step: step.name })
        return receipt
      },

      async commit(): Promise<void> {
        assertActive('commit')
        settled = true
        state = 'COMMITTED'
        emit('transaction/committed', { id })
      },

      async rollback(): Promise<void> {
        assertActive('roll back')
        settled = true
        state = 'ROLLING_BACK'
        emit('transaction/rollback-start', { id })
        let partial = false
        for (let index = steps.length - 1; index >= 0; index--) {
          const record = steps[index]!
          if (record.compensate === undefined) continue
          emit('transaction/compensation-start', { id, step: record.name })
          try {
            await record.compensate(record.receipt)
            emit('transaction/compensation-done', { id, step: record.name })
          } catch (error) {
            partial = true
            emit('transaction/compensation-failed', { id, step: record.name, error })
          }
        }
        state = partial ? 'ROLLBACK_PARTIAL' : 'ROLLED_BACK'
        emit('transaction/rollback-end', { id, state })
      },
    }
  }

  /**
   * Convenience runner: begin, execute each step in order, commit; on any
   * failure roll back (reverse-order compensation) and rethrow the error.
   * @param steps - steps executed sequentially in the given order.
   * @returns the settled transaction (COMMITTED on success).
   */
  async run(steps: readonly TransactionStep<unknown>[]): Promise<Transaction> {
    const tx = this.begin()
    try {
      for (const step of steps) {
        await tx.step(step)
      }
      await tx.commit()
    } catch (error) {
      await tx.rollback()
      throw error
    }
    return tx
  }
}

/**
 * Plugin entry: validate the config, then register the `ctx.transaction`
 * service. Invalid effect classifications throw at load time (fail-loud);
 * an absent config row is treated as an empty config.
 * @param ctx - Cordis context to register the service on.
 * @param config - plugin config (effect classification); defaults to empty.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateConfig(config)
  new TransactionService(ctx, config)
}
