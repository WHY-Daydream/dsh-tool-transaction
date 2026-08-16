# dsh-tool-transaction

[English](README.md) | 中文

> DeepSeek Harness 的 Saga 风格补偿事务。

`dsh-tool-transaction` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立第三方插件。它注册了一个 `ctx.transaction` 能力服务：带**逆序补偿**的事务化步骤执行。当多副作用工作流中的后续步骤失败时，已提交的步骤按逆序撤销，使系统回到一致状态。

```
create_order ✅ → reserve_inventory ✅ → charge_payment ❌
      ↓ rollback
release_inventory ✅ → cancel_order ✅
      ↓
ROLLED_BACK
```

> **不是分布式 ACID。** 这是 Saga 风格补偿事务：补偿是尽力而为的，补偿失败产生 `ROLLBACK_PARTIAL`，并留下逐步生命周期事件供人工处理。没有 2PC、分布式锁，也不承诺隔离性与持久性。

## 安装

在 `dsh` 安装中：

```sh
dsh plugin --profile web add @why-daydream/dsh-tool-transaction
dsh --profile web --dump-config   # 确认树中出现 `tool-transaction`
```

## 使用

消费方是工具、工作流和其他插件——这是能力服务，不是面向模型的大工具。

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

await tx.commit()          // 或 catch → await tx.rollback()
```

或使用顺序 runner（任一失败即回滚并重抛）：

```ts
await ctx.transaction.run([
  { name: 'create_order', execute, compensate },
  { name: 'reserve_inventory', execute, compensate },
])
```

### 语义

- 步骤按添加顺序执行；补偿按 **LIFO**（已提交步骤的逆序）执行。
- 每个 `compensate` 收到其对应步骤的 receipt。
- 失败的步骤不会被补偿（它从未提交）；其部分副作用由调用方负责。
- `commit()` 或 `rollback()` 落定后，不允许再添加步骤。

## 配置

```yaml
tool-transaction:
  effects:
    reserve_inventory: compensatable
    send_email: irreversible
```

工具副作用分类（并非所有工具都能回滚）：

| 分类 | 含义 | 默认适用 |
|---|---|---|
| `read-only` | 无副作用；永不补偿 | — |
| `reversible` | 无需补偿即可撤销副作用 | 未声明 `compensate` 的步骤 |
| `compensatable` | 由指定补偿动作撤销副作用 | 声明了 `compensate` 的步骤 |
| `irreversible` | 无法撤销；**加入时拒绝** | — |

分类为 `irreversible` 的步骤会被拒绝（报错清晰可见）；声明了 `compensate` 的 `read-only` 步骤同样被拒绝。非法分类值在插件加载时直接失败（fail-loud）。

## 生命周期事件

发布到共享事件总线，供 session 日志与遥测消费：

```
transaction/start
transaction/step-start            transaction/step-committed / step-failed
transaction/rollback-start
transaction/compensation-start    transaction/compensation-done / compensation-failed
transaction/rollback-end          （最终状态：ROLLED_BACK | ROLLBACK_PARTIAL）
transaction/committed
```

状态机：

```
ACTIVE ──commit──▶ COMMITTED
  │
  │ 失败 / 显式 rollback
  ▼
ROLLING_BACK ──补偿全部成功──▶ ROLLED_BACK
  │
  │ 补偿失败
  ▼
ROLLBACK_PARTIAL
```

## 开发

```sh
pnpm install
pnpm run build      # tsc 产出 lib/
pnpm test           # vitest（14 个测试，无网络）
pnpm run lint       # oxlint
```

devDependencies 通过 `link:` 规格解析到本地 DeepSeek Harness checkout，因此构建/测试针对开发时所用的同一套 Harness API。

## 兼容性

| dsh-tool-transaction | DeepSeek Harness |
|---|---|
| 0.1.x | 0.1.0-rc.5（已实测）· 0.1.0-rc.x（预期兼容） |

本插件依赖 cordis 服务缝与 `tools/*` 分发管线。DeepSeek Harness 仍处于 developer preview，可能引入破坏性变更；升级任一侧前请核对上表。

## 已知限制与待办

- **仅尽力补偿**——`ROLLBACK_PARTIAL` 记录逐步失败供人工处理；尚无重试或死信队列。
- **无自动工作流捕获**——步骤必须显式声明；插件不会把任意工具调用隐式纳入事务。
- **无持久化**——生命周期事件只发布不存储；可由消费 `session/event` 的遥测方案持久化。
- **无嵌套事务**——在步骤内调用 `begin()` 创建的是独立事务，不是外层事务的子事务。

## License

[MIT](LICENSE)
