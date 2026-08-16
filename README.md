# dsh-tool-transaction

English | [中文](README.zh.md)

> Saga-style compensating transactions for DeepSeek Harness.

`dsh-tool-transaction` is an independent third-party plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers a `ctx.transaction` capability service: transactional step execution with **reverse-order compensation**. When a later step of a multi-side-effect workflow fails, the already-committed steps are undone in reverse order, so the system returns to a consistent state.

```
create_order ✅ → reserve_inventory ✅ → charge_payment ❌
      ↓ rollback
release_inventory ✅ → cancel_order ✅
      ↓
ROLLED_BACK
```

> **Not distributed ACID.** This is a Saga-style compensating transaction: compensation is best-effort, and a failed compensation yields `ROLLBACK_PARTIAL` with per-step lifecycle events for manual resolution. No 2PC, no distributed locks, no isolation or durability guarantees.

## Install

From a `dsh` installation:

```sh
dsh plugin --profile web add @why-daydream/dsh-tool-transaction
dsh --profile web --dump-config   # confirm `tool-transaction` appears in the tree
```

## Usage

Consumers are tools, workflows, and other plugins — this is a capability service, not a model-facing tool.

```ts
const tx = await ctx.transaction.begin()

const order = await tx.step({
  name: 'create_order',
  execute: () => createOrder(),
  compensate: order => cancelOrder(order.id),
})

const inventory = await tx.step({
  name: 'reserve_inventory',
  execute: () => reserveInventory(),
  compensate: reservation => releaseInventory(reservation.id),
})

await tx.commit()          // or catch → await tx.rollback()
```

Or use the sequential runner, which rolls back and rethrows on any failure:

```ts
await ctx.transaction.run([
  { name: 'create_order', execute, compensate },
  { name: 'reserve_inventory', execute, compensate },
])
```

### Semantics

- Steps execute in the order added; compensation runs **LIFO** (reverse order of committed steps).
- Each `compensate` receives its own step's receipt.
- A failed step is never compensated (it never committed); its partial effect is the caller's responsibility.
- After `commit()` or `rollback()` settles, no further steps may be added.

## Config

```yaml
tool-transaction:
  effects:
    reserve_inventory: compensatable
    send_email: irreversible
```

Tool effect classification (not every tool can roll back):

| Effect | Meaning | Default for |
|---|---|---|
| `read-only` | no side effects; never compensated | — |
| `reversible` | side effect undone without compensation | steps without `compensate` |
| `compensatable` | side effect undone by a named compensation | steps with `compensate` |
| `irreversible` | cannot be undone; **denied** at join time | — |

A step classified `irreversible` is rejected with a load-visible error; a `read-only` step that declares a `compensate` is also rejected. Invalid effect values fail at plugin load (fail-loud).

## Lifecycle events

Published on the shared event bus for session logs and telemetry:

```
transaction/start
transaction/step-start            transaction/step-committed / step-failed
transaction/rollback-start
transaction/compensation-start    transaction/compensation-done / compensation-failed
transaction/rollback-end          (final state: ROLLED_BACK | ROLLBACK_PARTIAL)
transaction/committed
```

State machine:

```
ACTIVE ──commit──▶ COMMITTED
  │
  │ failure / explicit rollback
  ▼
ROLLING_BACK ──all compensation ok──▶ ROLLED_BACK
  │
  │ compensation failure
  ▼
ROLLBACK_PARTIAL
```

## Development

```sh
pnpm install
pnpm run build      # tsc emits lib/
pnpm test           # vitest (14 tests, no network)
pnpm run lint       # oxlint
```

Dev dependencies resolve to a local DeepSeek Harness checkout via `link:` specs, so build/test run against the same Harness APIs the plugin was developed against.

## Compatibility

| dsh-tool-transaction | DeepSeek Harness |
|---|---|
| 0.1.x | 0.1.0-rc.5 (verified) · 0.1.0-rc.x (expected) |

This plugin depends on the cordis service seam and the `tools/*` dispatch pipeline. DeepSeek Harness is in developer preview and may introduce compatibility-breaking changes; verify the matrix above before upgrading either side.

## Known Limitations and Deferred Work

- **Best-effort compensation only** — `ROLLBACK_PARTIAL` records per-step failures for manual resolution; no retry or dead-letter queue yet.
- **No automatic workflow capture** — steps must be declared explicitly; the plugin does not intercept arbitrary tool calls into implicit transactions.
- **No persistence** — lifecycle events are emitted but not stored by this plugin; a telemetry consumer of `session/event` can persist them.
- **No nested transactions** — calling `begin()` inside a step creates an independent transaction, not a sub-transaction of the outer one.

## License

[MIT](LICENSE)
