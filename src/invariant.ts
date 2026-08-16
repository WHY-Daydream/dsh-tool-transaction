/**
 * Package-owned invariant companion for `@why-daydream/dsh-tool-transaction`.
 * @module @why-daydream/dsh-tool-transaction/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@why-daydream/dsh-tool-transaction'

/** Cordis companion plugin name. */
export const name = 'tool-transaction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant yet: the transaction service's per-step lifecycle
 * events (`transaction/*`) are the contract surface; a future invariant may
 * verify event ordering (step-committed before rollback-start, compensation
 * count == committed step count, etc.).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
