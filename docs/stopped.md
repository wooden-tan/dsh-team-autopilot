# 项目停止说明

**状态：已停止维护。** 停止日期 2026-11-02。代码停在 0.6.7，不再加功能、不再排待办。

这一页替代「继续做」的判断，写给三个月后的自己：为什么停、停之前查到了什么、磁盘上还留着什么、怎么彻底删掉。

## 为什么停

不是功能做不出来——三件事（自动唤醒、僵死回收、派发时刻的写域软锁）都已经能跑，也都有真机记录。停的原因是它的价值前提没有成立：

1. **分发面太薄，功能再好也到不了用户手里。** 应用内插件目录有 7406 条，本项目不在其中；GitHub 仓库 2026-10-28 才创建，截至停止时 0 star（见下节）。目录里确实没人做「确定性派发」，但「没人做」也可能是「没人要」。
2. **它的价值只对「真的会撒手不管」的用户成立。** 官方在五个方向上都明确不做自动派发与僵死回收（原文见 README 最后一节引的 `goal-round-driver` 三句）。这既是机会窗口，也说明这项能力是加分项而非刚需——人在场时，手动发一条消息比装一个插件便宜。
3. **价值建立在实验性 API 上，已经付过一次代价。** Team 把消息通道改成 mailbox 之后，原先依赖的投递确认能力直接消失（README「边界」一节）。每跟随一次上游重构，插件就有一次功能倒退，而这个项目只有一个人在维护。
4. **与已装的 `@nanmicoder/dsh-agent-teams` 功能重叠**，且两者对僵死任务的处置方向相反（本项目回池、对方换人），同装必须人工确认兼容边界。

一句话：**工程上成立了，产品上没有需求证据。**

### 为什么没分发（2026-10-28 目录快照）

这条生态里插件被发现不是靠人传人，而是靠一份目录数据：`awesome-dsh-plugin.com/plugins.json`，它同时是 `dshmarket` 等应用内市场的数据源。当时实测项目**不在**这份索引里——目录 7406 条、其中带 npm 映射（能显示下载量、按包名安装）3823 条、本插件所在的 `workflow` 分类 413 条，全量检索无命中。

两条路进度不同：GitHub 侧该做的已经做了（`description` 已填、8 个 `dsh-plugin` 类 topics 已设），按 topic 每日爬取的目录站会自己发现我们；**进不了应用内市场**才是一键安装缺失的原因，而进 `plugins.json` 只能投稿 PR，这一步在停止前没做。

顺带记下当时的竞争位：413 条 `workflow` 里团队类插件不少，但没有一条在做「任务 ready 时由后台 tick 唤醒空闲成员 / 持有者停摆后自动收回任务 / 写域重叠在派发时刻当软锁」中的任何一件；最接近的 `dsh-task-dispatch-table`（定时表驱动，派的是独立 session）与 `dsh-agent-board`（文件级排他锁，主 agent 派给一次性 subagent）都不碰原生 Agent Teams。这个组合确实空着——但「空着」也可能是「没人要」。目录数字会随他人投稿变化，引用时以当次抓取为准。

## 停之前最后核实的能力边界

2026-11-02 对着官方 master 文档与本仓库锁定的 rc.2 类型定义逐条查过。要重启这个项目，从这里读起，不要再查一遍。

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 投递确认 | **成立，rc.2 可用** | `sendMessage` 返回 `messageId`；根级监听 `agent/inbox/claimed` 按成员 agent + `message.id` 对账，无匹配则 `discarded` 或冷却超时。可把 `outcome=unchecked` 升级成真证据，分清「没送达」与「送达没认领」 |
| 团队 token 预算闸 | **部分成立** | `tokenMeter.measure(session)` / `contextPressure()` / `estimateMessage()` 能度量；但没有团队级聚合、没有限额机制，官方明文「not a billing or gating input」「harness 中没有任何机制依据它做决定」 |
| per-member model | **不成立** | `SpawnTeammateRequest` 只有 `name/description/prompt/context/provider/signal`，`provider` 是 subagent 后端名不是模型；内层 `startActivation` 只转发 `{ prompt, parent }`，`cwd` 与 `agentOptions` 都没转 |
| 独立工作目录 | **部分成立** | Team 无 cwd；`ctx.worktrees.create(agent)` 可把成员切进自己的检出目录，但属 experimental、默认关闭，且成员各进 worktree 后 `writeScopes` 重叠告警失真 |
| toolPolicies / 质量门 | **不成立** | `ApprovalPolicy` 只有 `ask \| never`；`PresetSpec` 只有 `sandbox` + `approval`，agent/profile 选择不属于它；插件唯一钩子是 `approval/request` 逐次否决 |
| 叫醒 Lead / 上报通道 | **成立但代价明确** | `inject()` 只排队、不唤醒空闲 driver；`steer()` 与 `send(msg, target, wakeup=true)` 会给空闲 driver 开一轮——花一整轮 token，且消息以 user 角色出现在 Lead 会话里 |
| `/dispatch` 命令面 | **需要抬基线** | `ctx.commands.register()` 存在，但依赖 `@deepseek-ai/dsh-commands`，rc.2 没有这个包；抬基线会与「保住 rc.2 用户」的版本区间冲突 |

### 顺带更正 README 里的一处结论

README 的设计决策第 10 条末尾写「想让卡死/停派主动上报到 Lead 时发现路是堵的」。准确说法是：**路没堵，是收费的**——`inject` 能把消息递到 Lead 的下一步，但空闲的 Lead 不会因此醒来；要让它醒来就得付一整轮 token，还要冒充一个 user 消息出现在会话里。零 token 这个承诺比一条告警值钱，所以停派与卡死仍然只走三条不花 token 的通道（`statusFile` 日志行、`team_autopilot_status` 工具输出、状态渲染里的 `lastStall` / `warning:` 行）。

## 停止时磁盘上的状态

| 位置 | 内容 | 状态 |
| --- | --- | --- |
| `C:\Users\Tan11\.dsh\profiles\desktop\package.json:19` | 依赖 `dsh-team-autopilot@0.6.4` | 仍登记 |
| 同上 `:55` | bundles 数组含 `dsh-team-autopilot` | 仍登记 |
| `C:\Users\Tan11\.dsh\profiles\desktop\cordis.patch.yml:34-40` | `id: team-autopilot` 配置块 | `disabled: true`，不加载 |
| `C:\Users\Tan11\.dsh\profiles\autopilot-lab\package.json` | 依赖 `file:E:/deepseekharness/dsh-team-autopilot` | 仍登记 |
| `C:\Users\Tan11\.dsh\profiles\autopilot-lab\cordis.patch.yml:7-10` | `id: team-autopilot`（`dryRun: true`） | 停止时补上 `disabled: true` |
| 两个 profile 的 `node_modules/dsh-team-autopilot/` | 已安装副本 + 各自的 `pnpm-lock.yaml` 条目 | 仍在 |

物理删除需要包管理器把 `node_modules` 与锁文件一起更新，否则目录与锁文件会不一致。这一步没在停止时自动做——dev 环境里 `pwsh` 报 `SetNamedSecurityInfoW failed (Win32 5)`，本会话没有任何可用 shell。

## 彻底卸载

1. 在 DSH 的插件面板里卸载 `dsh-team-autopilot`：面板卸载会同时改 `package.json`、`bundles` 与锁文件，这是唯一不会留下不一致的路径。
2. `autopilot-lab` 是实验用 profile，整个删掉也安全。
3. 仓库本身建议留着并设为 GitHub archived：这里的真机记录（多队并存、回收、熔断）比代码更值钱。

## 什么条件下重启

- 出现具体的用户诉求：要在无人值守下跑团队，且明确接受模型唤醒成本；
- 或官方补上「任务就绪即唤醒 owner」——那时本插件的核心卖点消失，也就不必重启；
- 或官方补上团队级预算闸与成员级模型选择——那两项现在是缺口，但缺口的解法不该由插件自己造。

重启时先读这一页，然后从分发（上面「为什么没分发」一节）入手，而不是从功能入手。
