# dsh-team-autopilot

**Deterministic auto-dispatch for the native Agent Teams seam (`ctx.agentTeams`).**

> **项目已停止维护（2026-11-02），代码停在 0.6.7。** 停项原因、停止前逐条核实的能力边界、磁盘残留与卸载方式见 [docs/stopped.md](docs/stopped.md)。
> 本页只留「装上怎么用」。设计理由、真机记录、仍未验证的部分在 [docs/design.md](docs/design.md)，逐场景验证手册在 [docs/verify.md](docs/verify.md)。

![左边是原生 Agent Teams：任务 ready、两个成员空闲，但没有人被叫醒。右边是同一块板子在插件下一轮的观测：任务出现、唤醒 worker-c、被认领、完成，约 2 秒，路径中没有任何模型调用。](https://raw.githubusercontent.com/wooden-tan/dsh-team-autopilot/main/assets/how-it-works.png)

上图右侧不是示意：底部三行是 2026-10-28 真机日志的原样字段，逐条对照见 [docs/design.md](docs/design.md)。图由 `scripts/render-assets.py` 从这些字段渲染，不是手绘。

官方 Agent Teams 给你 roster、任务板和 mailbox；本插件让这套东西自己转起来。它**不建第二个团队层**——没有自己的任务存储、成员注册表或消息通道，卸载即失效、不留残留状态；决策由**代码**做出，不向主 agent 注入策略文本，不花 token 做调度判断。

## 它补的三个空档

原生 Agent Teams 的模型策略里写死了三件事：

> **Task readiness never starts an owner.**  
> `wait_agent` observes only changes after that call starts, never wakes a member.  
> **The owner is never released automatically** — not for inactivity, interruption, process exit, or failed work.  
> Write-scope overlap is **advisory, not a lock**.

| 空档 | 本插件的做法 |
| --- | --- |
| 任务变成可执行之后没有人被自动叫醒，得靠 Lead 手动发消息推 | 后台 tick 扫板，按规则挑人并 `sendMessage` 唤醒；一轮一个团队只 tick 一次 |
| 成员停摆后它认领的任务永远挂在 `in_progress`，占着写域和并发槽 | 用 `agent/status` 的真实回合边界（关掉则退回计时）判定应答与僵死，按上限回收、超限停派 |
| 写域重叠只是提示，不会拦截 | 派发时刻按 `writeScopes` 判冲突，重叠加软锁，不派第二个 |

## 安装

```bash
npm i dsh-team-autopilot
```

或交给 CLI 版 dsh 的插件管理器：

```bash
dsh plugin --profile web add dsh-team-autopilot
```

已发布版本自带预构建的 `dist/`，安装后无需再跑构建。`@deepseek-ai/*` 全部声明为 **optional peer**，由宿主 profile 提供；在宿主之外单独 `import` 本包会在运行时抛 `Cannot find package '@deepseek-ai/schemastery'`——这是预期行为。

## 前置条件

必须先有一个提供 `ctx.agentTeams` 的组合，然后把本插件叠在它之后：

```bash
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile
dsh plugin --profile web add dsh-team-autopilot
```

`cordis.patch.yml` 会插入 `team-autopilot` 一行。若 `agentTeams` 不存在，插件因 `inject` 无法解析而不会加载——这是预期行为，不是 bug。

## 配置

| 键                | 默认      | 说明                         |
| ---------------- | ------- | -------------------------- |
| `enabled`        | `true`  | 关掉后只保留状态工具，不跑循环            |
| `tickTimeoutMs`  | `30000` | 每次等待窗口，原生硬限制 10000–3600000；一个团队都没有、且宿主没有事件总线时，这个值仍是空闲退避的上限（见下） |
| `maxConcurrent`  | `2`     | 团队并发预算默认值（见下）                  |
| `wakeCooldownMs` | `60000` | 同一任务在该窗口内不重复唤醒             |
| `dryRun`         | `false` | 只记录决策，不发消息                 |
| `teamBudgets`    | `{}`    | 按团队覆盖并发预算，key 为团队 `TeamId`（root Session 标识） |
| `errorThreshold` | `3`     | 连续 `sendMessage` 失败几次后切开熔断      |
| `openCooldownMs` | `60000` | 熔断打开后保持多久再半开探针              |
| `halfOpenProbe`  | `1`     | 半开阶段允许的探针派发次数               |
| `reclaimAfterMs` | `300000` | 持有者 `inactive` 持续多久后把任务收回池子（1000–3600000） |
| `reclaimOnFailed` | `true`  | 持有者 `failed` 时是否立即回收            |
| `reclaimRetryLimit` | `3`   | 同一任务被回收几次后停止派发（`0` = 不限，0–32）。见第 9 条 |
| `statusFile`     | `''`    | 状态有变化时追加一行到该文件（绝对路径），空 = 关闭。见下「零 token 观测」 |
| `statusHeartbeatMs` | `600000` | 状态未变也至少这么久写一行；`0` = 逐轮写 |
| `livenessEnabled` | `true` | 是否订阅 `agent/status` 用真实的回合边界判定「唤醒是否被答复」，关掉则退回纯计时 |
| `livenessGraceMs` | `60000` | 有回合边界证据时，回合结束后多久仍没完成就回收（替代 `reclaimAfterMs`） |
| `livenessSettleGraceMs` | `3000` | 回合结束后再等多久才把一次唤醒判定为「已被答复」，避开状态写入的竞态 |
| `stalledRunningMs` | `900000` | 持有者持续 `running`/`provisioning` 多久算卡死并上报；`0` = 关闭。**只上报，不动任务板** |
| `interruptStalled` | `false` | 卡死时是否真的 `interrupt` 那个成员。**默认关**：中断会掐掉正在做的工作 |
| `wakeBudgetPerHour` | `0` | 每队**滚动一小时**内最多发起多少次唤醒（一次唤醒 = 一个模型回合，也就是钱）。`0` = 不设上限。花完的那一轮不再派发，记 `why=budget` 并累加 `budgetSkips` |

数值越界会被收敛：schema 先拒绝明显非法的输入，`resolveConfig` 再兜一层。兜底这层不是装饰——`maxConcurrent: 0` 会把槽位永久归零，`halfOpenProbe: 0` 会让熔断器卡在 half-open、从此再不发一条唤醒，而两者都不报错，看起来和「今天没活」一模一样。`cordis.patch.yml` 只设 `enabled: true`，其余走 schema 默认值；要改就在自己的 profile 里按 `id: team-autopilot` 覆盖（默认值只有一份，抄进 patch 会在默认值改动时悄悄覆盖掉用户意图）。

**一个团队都没有时的等待是事件，不是定时器。** 有 Lead 时循环为每个团队挂 `waitForChange`，名册或任务一变就醒（原生团队服务的行为，插件只是复用）。真正没有 Lead 时改等宿主文档化的 `agent/created`，只认没有 `parentAgent` 的 root——所以另一套把成员建成子 agent 的 Team 实现不会叫醒我们。有事件总线的宿主上**不挂任何定时器**（宿主发布 root 与发出事件是同一条路径，事件就是状态变化本身）；唯一的定时是「root 在、却解析不出 Lead」的一次 1 秒有界重读。2s→30s 退避只剩一个使用者：完全没有事件总线的宿主。推理与实测见 [docs/design.md](docs/design.md)。

## 怎么验证

```bash
node node_modules/typescript/bin/tsc --noEmit   # → 零错误
node tests/verify.ts                            # → OK — 77 checks passed
node tests/integration.ts                       # → OK — 48 integration checks passed
node scripts/acceptance.mjs                     # → ✅ 全部通过 — 28/28 项验收通过
node scripts/verify-status.mjs                  # → PASS（用真实 dsh-tools 编译器校验输出 schema）
node scripts/verify-pack.mjs                    # → 7 required files, 0 forbidden, 0 dangling
```

`npm test` = `verify` + `integration` + `acceptance` + `verify:status` 四套聚合。其中 `verify:status` 是唯一用**真实 `dsh-tools` schema 编译器**校验 `team_autopilot_status` 输出的脚本——输出 schema 若被宿主拒绝，工具会在安装后静默失效（不报错、不派发），只有这一项能提前拦住；它同时守三处漂移：输出键集合、`Config` 默认值、本页配置表。

真机端到端要真实 `dsh` 宿主 + 可用 LLM provider，无法在无头环境跑；进程内已用真实 `tick()` 与 `loop()` 覆盖调度判定。逐场景步骤（挂载自检、完全重启、dryRun 四场景、熔断、真实派发、僵死回收、多团队）与可直接粘贴进 Harness 的提示词见 [docs/verify.md](docs/verify.md)；桌面 profile 的三个 pnpm 坑与独立 lab profile 见 [docs/lab-profile.md](docs/lab-profile.md)。挂载自检：`node scripts/verify-mount.mjs`（`npm run verify:mount`），重启前后各跑一次。

## status 字段速查

```
autopilot active health=ok version=0.6.7 up=17m rounds=42 dispatched=3 reclaimed=0 ...
```

- `health=ok|off|error`；`up=` 是进程存活时长（重启归零），不是运行时长。
- `dispatched` / `reclaimed` / `skipped` 是累计值；某一轮里累计数没变就不写日志行。
- `skipped` 拆成 `scope` / `noMember` / `noTask`；熔断打开时 `held`（状态工具里叫 `breakerBlocked`）增长，与任务桶的 `blocked`（卡依赖）无关。
- 完整字段表、`outcome=unclaimed` 对下一轮决策的影响、`statusFile`（零 token 观测：YAML、样例日志、分桶表、写入语义）见 [docs/design.md](docs/design.md)。

## 文档

| 文件 | 讲什么 |
| --- | --- |
| [docs/stopped.md](docs/stopped.md) | 为什么停在 0.6.7：分发面、官方覆盖、能力边界、重启条件、磁盘残留与卸载 |
| [docs/design.md](docs/design.md) | 与别的团队插件的差异、能否共存、11 条设计决策、真机验证记录、仍未验证、status 与 statusFile 详解、边界、开发与发布 |
| [docs/verify.md](docs/verify.md) | 逐场景验证手册（桌面联调 / 僵死回收专项 / 多团队），附两套可直接粘贴的提示词 |
| [docs/lab-profile.md](docs/lab-profile.md) | 一次性 lab profile：独占任务板与日志，专门复验；两个真机环境的坑 |
| [docs/team-collab-task-v2.md](docs/team-collab-task-v2.md) | 真机派发验证用的任务模板：把成员改成被动等待，让 autopilot 成为唯一派发源 |

## 卸载

```bash
dsh plugin --profile web remove dsh-team-autopilot
```

然后完全退出宿主并重启。插件不持有任何持久状态，卸载后原生 Agent Teams 回到原状。若开过 `statusFile`，那是一个普通文本日志，可直接删除。
