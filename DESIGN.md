# dsh-tool-transaction — Design

> Saga-style compensating transactions for DeepSeek Harness. Not distributed ACID.

## One-line positioning

**Transactional tool execution with Saga-style compensation for DeepSeek Harness.**

An agent calls side-effectful tools in sequence; when a later step fails, the
transaction rolls back by compensating the already-committed steps **in reverse
order**.

```
create_order ✅ → reserve_inventory ✅ → charge_payment ❌
      ↓ rollback
release_inventory ✅ → cancel_order ✅
      ↓
ROLLED_BACK
```

## State machine

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

## API (capability service: `ctx.transaction`)

Consumers are Tools / Workflows / Plugins — this is **not** one big model-facing tool.

```ts
const tx = await ctx.transaction.begin()

const order = await tx.step({
  name: 'create-order',
  execute: () => createOrder(),
  compensate: order => cancelOrder(order.id),
})

const inventory = await tx.step({
  name: 'reserve-inventory',
  execute: () => reserveInventory(),
  compensate: reservation => releaseInventory(reservation.id),
})

await tx.commit()          // or catch → await tx.rollback()
```

Convenience runner for sequential steps:

```ts
await transaction.run([
  { name: 'create_order', execute, compensate },
  { name: 'reserve_inventory', execute, compensate },
])
```

Key semantics:

- compensation runs **LIFO** (reverse order of committed steps)
- each `compensate` receives its own step's receipt
- a failed step is not compensated (it never committed); its own failure is
  reported and its possible partial effect is the caller's responsibility

## Lifecycle events

Published on the shared event bus (session logs / telemetry can consume):

```
transaction/start
transaction/step-start
transaction/step-committed
transaction/step-failed
transaction/rollback-start
transaction/compensation-start
transaction/compensation-done
transaction/compensation-failed
transaction/rollback-end      (final state: ROLLED_BACK | ROLLBACK_PARTIAL)
transaction/committed
```

## Tool effect classification

Not every tool can roll back. Configure per tool name:

- `read-only`      — no side effects; never compensated, never blocks
- `reversible`     — side effect undone by the same call shape
- `compensatable`  — side effect undone by a named compensation action
- `irreversible`   — cannot be undone; MVP policy: **deny** joining a transaction

```yaml
tool-transaction:
  effects:
    reserve_inventory: compensatable
    send_email: irreversible
```

## Boundaries (v0.1.0 explicitly does NOT promise)

- No database-level ACID (Atomicity / Consistency / Isolation / Durability)
- No cross-service 2PC / distributed locks
- Compensation is best-effort: a failed compensation yields `ROLLBACK_PARTIAL`
  with per-step event records for manual resolution

## Integration with dsh-chaos

`dsh-chaos` injects failures (e.g. HTTP 500 on `charge_payment`);
`dsh-tool-transaction` then proves the agent recovers side-effect consistency:

```
dsh-chaos: HTTP 500 → step C fails
dsh-tool-transaction: rollback → compensate B → compensate A → ROLLED_BACK
```
