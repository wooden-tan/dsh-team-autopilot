# 验证手册

> 桌面版联调、僵死回收专项、多团队验证，以及两套可直接粘贴进 Harness 的提示词，合成一册。
> 项目已停止维护（2026-11-02）：下文里的版本号、界面位置、字段名都是停止时的快照，能跑的代码停在 0.6.7。

| 部分 | 内容 | 什么时候看 |
| --- | --- | --- |
| 第 1 部分 | 挂载自检、完全重启、加载确认、dryRun 四个场景、熔断、真实派发、回滚、字段速查 | 刚装上，或改完配置想确认真生效 |
| 第 2 部分 | 僵死回收：观测字段、把等待调短、三个触发条件的可制造性、场景 E–H、dryRun 分层、排查表 | 想验 `reclaimAfterMs` / `reclaimOnFailed` |
| 第 3 部分 | 多团队：两个会话各看一张板子，隔离还是串台 | 装了多团队之后 |
| 附录 A | 派发路径的粘贴提示词（只建任务，别的一概不做） | 不想手点，直接把提示词交给 Lead |
| 附录 B | 回收路径的粘贴提示词（P1–P7 + FAQ） | 同上，验回收 |

## 第 1 部分 · 桌面版联调

> 目标：确认 `dsh-team-autopilot` 在 **DeepSeek Harness 桌面版**里真正加载、并按预期工作。
> 分两段：**① 挂载自检**（现在就能跑，无需重启）→ **② 运行验证**（重启 App 后在团队里造场景）。
>
> 目录：profile = `%USERPROFILE%\.dsh\profiles\desktop`；插件已作为 bundle 挂载，首次 `dryRun: true`（只记录、不唤醒）。

---

### 0. 快速自检（重启前/后都能跑）

```bash
cd <你的 dsh-team-autopilot 检出目录>
node scripts/verify-mount.mjs
# 或 npm run verify:mount
```

- **重启前**期望：`OK — 10 mount checks passed, 1 warning(s) for <profile>`（WARN = 日志里还没有 team-autopilot，属正常）。
- **重启后**期望：同一命令的 WARN 变成 **PASS**，仍是 `OK …` 开头。

> 一旦你在「首次安全模式」之外跑过（把 `dryRun` 改成 `false`），`first-run dryRun === true` 这一项**会一直是 FAIL**，汇总行也变成 `FAILED — 1/11 checks failed`。这是**预期结果，不是故障**：那条检查守的是「第一次装上时必须是 dryRun」，不是「永远是 dryRun」。判断插件是否正常，看其余 10 项是否全 PASS。

逐项含义与失败处理：

| 检查项 | 含义 | FAIL 时怎么办 |
|---|---|---|
| `profile directory exists` | profile 目录在 | 确认路径，或用 `DSH_PROFILE=...` 指定 |
| `bundle "dsh-team-autopilot" registered` | `dsh.profile.bundles` 含本插件 | 在 `package.json` 的 bundles 追加一行 |
| `dependency declared` | `dependencies` 里有本插件（registry 版本写 `^x.y.z`；本地 tarball 写 `file:./*.tgz`） | 修正 `dependencies` 后重装 |
| `entry "main" is dist/index.mjs` | 包入口指向构建产物 | 重新 `npm run build` + repack |
| `dist/index.mjs built` | 构建产物存在 | 同上 |
| `cordis.patch.yml shipped` | 包内携带 patch | 确认 `files` 白名单含它 |
| `lockfile records dsh-team-autopilot` | 锁文件里有这个依赖（registry 与 `file:` 两种写法都认） | 见 README「桌面 profile 的三个坑」第 3 条 |
| `profile patch targets team-autopilot` | profile patch 覆盖了本插件 | 补 `- id: team-autopilot` 段 |
| `first-run dryRun === true` | 首次安全模式 | 首次安装时补 `dryRun: true`；已经跑过就不必管 |
| `logs mention team-autopilot`（WARN/PASS） | 运行日志出现过本插件 | 见第 3 节排查 |

---

### 1. 重启 App（必须**完全退出**）

bundle 的组合只在 App 启动时进行，**关窗口 ≠ 退出**。

1. 托盘图标右键 → 退出；或任务管理器确认**所有** `WorkBuddy.exe` / Harness 进程已结束。
2. 重新打开 App。
3. 重跑 `node scripts/verify-mount.mjs`，确认那条 WARN 变 PASS。

---

### 2. 确认插件已加载（三个独立信号，任一成立即可）

#### 2.1 状态工具出现（最直接）

在会话里让模型调用工具 **`team_autopilot_status`**。期望返回类似：

```
autopilot dry-run
totals rounds=0 dispatched=0 suppressed=0 skipped=0 unclaimed=0 reclaimed=0 parked=0
caller team=session-… tasks=3 inFlight=1 claimable=1 blocked=1 done=0 idle=1 slots=1 (live)
teams=1
  team=session-… ticks=3 dispatched=0 suppressed=0 skipped=0 (scope=0 noMember=0 declined=0 parkedSkips=0) why=- breaker=closed trips=0 held=0 reclaimed=0 unclaimed=0 pending=0 tasks=3 inFlight=1 claimable=1 blocked=1 done=0 idle=1 slots=1 (726ms ago)
    lastReclaim none
    lastDispatch none
```

- `dry-run` 是因为 `dryRun: true`（`enabled` 仍为 `true`，但只记录判定、不真发消息），**但计数会随轮次增长**，这是正常的。三态：`inactive`（未启用）/ `dry-run`（启用但只记不发）/ `active`（正常派发）。
- `caller` 一行是**调用方自己团队**的实时板（live），`team=` 那行是 autopilot 上次 tick 的快照并带年龄——两者数值不一致是正常的。
- `skipped` 后面的 `(scope / noMember / declined / parkedSkips)` 是跳过原因拆分：写域冲突 / 没有空闲成员 / 空闲成员全都拒绝过这个任务 / **回收太多次已被停派**。前三个是「这一轮为什么没派」，第四个是「这个任务已经不派了」——要看具体是哪几个任务，用 status 工具，它把 `parked` 逐条列出（`task` / `after` / `lastOwner`）。
- `tasks` 是**五分桶，恒等于总数**：`inFlight + claimable + parked + blocked + done == tasks`。`blocked` 是卡在依赖上的（`pending` 未 `ready` 且无 owner），`done` 是 `completed`/`deleted`。所以「4 个任务、0 可派、2 个空闲」能立刻区分出是卡依赖还是活已干完。
- `lastReclaim none` / `lastDispatch none` 是**「还没发生过」**，不是字段缺失。空行与「这版不会报这个字段」在读的人眼里一样，所以显式打 `none`。
- 若模型说"没有这个工具" → 插件未加载，跳到 2.4。

#### 2.2 状态日志文件（`statusFile`）——安静是正常的

`cordis.patch.yml` 里设了 `statusFile` 时，插件会往该文件追加状态行。**关键在于它不是每 tick 一行**：

- 每次**进程启动**写一行 `autopilot-start`，带版本号和生效配置
- 团队的**字段有变化**时立即写
- **没有变化**时只在 `statusHeartbeatMs`（默认 10 分钟）到期时写一行心跳
- **累计跳过计数不算变化**：`skip` / `scope` / `noMember` / `declined` / `parkedSkips` 是累计值，任务一直没人接时它们每轮都在涨，若算作变化就等于逐轮写。`< 0.3.4` 正是栽在这里——只要团队里有被拒过一次的任务，日志就会退化回每 tick 一行。冷却/熔断累计 `suppressed` / `held` 同理
- **但本轮原因 `why` 算**：计数不进比较，原因进。从 `why=-` 变成 `why=scope`，或变成 `why=declined`（全员拒接、插件就此停手），都会立即写一行，不必等心跳——这是「安静」和「瞎」的分界
- **`parks=` / `unparks=` / `reclaims=` 事件也算**：停派、解除停派、回收一个任务都是要人接手的事，不能等到心跳才看得见。它们由 `parks=<任务><上个 owner> after=N` / `unparks=<任务>` / `reclaims=<任务><上个 owner>` 表达，只会在**本轮发生了这些事件**时出现，不是每轮一行

所以「文件里 10 分钟没有新行」是**按设计在工作**，不代表插件停了。要区分「安静」和「死了」，看有没有下一条心跳：

```bash
f=~/.dsh/team-autopilot.log
tail -1 "$f"                              # 当前状态
grep autopilot-start "$f" | tail -1       # 最近一次启动的版本与配置
awk '$1 >= "2026-10-28T08:52"' "$f"       # 某次重启之后的全部行
```

一行长这样（字段与 status 工具同源，顺序固定）：

```
2026-10-28T08:52:57.086Z team=session-… ticks=1 dispatched=0 suppressed=0 skip=0 scope=0 noMember=0 declined=0 parkedSkips=0 why=- unclaimed=0 pending=0 reclaimed=0 tasks=0 inFlight=0 claimable=0 blocked=0 done=0 idle=0 slots=2 breaker=closed trips=0 held=0
```

读法：

| 想知道 | 看哪里 |
|---|---|
| 当前版本、配置有没有生效 | `grep autopilot-start`，`version=` / `tickMs=` / `reclaimMs=` / `retryLimit=` / `heartbeatMs=` |
| 是不是刚重启过 | 出现新的 `autopilot-start`；团队行 `ticks=1`（内存态归零） |
| 有效节拍对不对 | 两次心跳的 `ticks` 差 ÷ 秒数 ≈ `tickMs`。安静 10 分钟应新增约 20 个 tick（只多不少：真实变化会提前唤醒），**翻倍说明在跑 `<0.3.1`** |
| 有没有派发 | `dispatched=`；配合 `unclaimed=` / `reclaimed=` |
| 为什么没派 | `why=` 指出本轮原因（`scope` / `noMember` / `declined` / `parked` / `-`），再用 `claimable=`/`blocked=`/`done=`/`idle=`/`slots=` 定位到具体任务 |
| 有几条唤醒还在等判定 | `pending=`。`outcome=unchecked` 只反映**最后一条**唤醒，一轮派两个任务时另一个只能靠 `pending` 看出来 |
| 插件是不是已经停手 | `why=declined` + `dispatched=` 不再增长 → 所有空闲成员都拒过；`why=parked` → 有任务被回收太多次，已停止派发（同一行会带 `parks=<任务><上个 owner> after=N`） |
| 回收是不是在空转 | `reclaimed=` 一直涨而 `done=` 不动 → 任务被反复回收重派。`< 0.3.7` 没有终点（真机实测 20 分钟回收 12 次、派发 19 次、`done=0`）；现在达到 `retryLimit=`（默认 3）会停派，日志出现 `parks=` |
| 日志文件是哪份代码写的 | 团队行里没有 `why=`/`pending=` → 版本低于 `0.3.5`；没有 `blocked=`/`done=` → 低于 `0.3.2`；status 的团队对象里没有 `why` → 低于 `0.3.6`；团队行没有 `parkedSkips=`、启动行没有 `retryLimit=` → 低于 `0.3.7` |

> 写入失败一律静默——观测是便利，满盘或只读 profile 不能卡住派发。所以文件不存在或某段没写，不能反推成「插件没跑」，要用 2.1 的状态工具交叉确认。

#### 2.3 日志出现本插件

```bash
ls -t ~/.dsh/profiles/desktop/.plugin-manager/logs/operation-* | head -1
# 查看该目录下最近日志，搜 team-autopilot
grep -ri "team-autopilot" ~/.dsh/profiles/desktop/.plugin-manager/logs | tail -20
```

成功时至少能看到 bundle 被组合、`team-autopilot` 被 insert 的痕迹。

#### 2.4 加载失败排查表（按报错对号入座）

| 现象（日志关键字） | 原因 | 处理 |
|---|---|---|
| `inject` / 缺少 `agentTeams` | profile 未提供团队服务 | 确认 bundles 含 `@deepseek-ai/dsh-experimental-agent-team-profile` |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools` | 宿主要求的 kernel 包没注入 | 核对桌面版版本；确认市场插件能正常加载（同构问题） |
| `defineTool(...)` / schema 相关报错 | `STATUS_SCHEMA` 与宿主 dsh-tools 版本不符 | 把具体字段发我，按报错修 schema |
| `z.dict is not a function` | schemastery 太旧 | 需 `@deepseek-ai/schemastery >= 3.18.5` |
| 完全没有任何 team-autopilot 记录 | bundle 没生效/文件缺失 | 第 0 节自检红项优先修 |

---

### 3. dryRun 行为验证（安全，不会真的发消息）

前提：`dryRun: true`（当前即如此）。每一步都只用 `team_autopilot_status` 的计数字段判断。

#### 场景 A —— 就绪任务 + 空闲成员（应派发）

1. 记下当前 status：`rounds / dispatched`。
2. 建一个 **ready 且无 owner** 的任务；确保团队里有一个 **inactive** 成员。
3. 触发一次团队变化（新建/编辑任务即可，会唤醒 `waitForChange`）。
4. 再查 status。
   - 期望：`rounds` 增加；`dispatched` 增加；`skipped=0`；`breaker=closed`。
   - 顺便看一眼 `lastDispatch task=<id> to=<member> wakes=1 dry-run outcome=unchecked`——dryRun 下 `sent` 显示为 `dry-run`。
   - dryRun 下 `dispatched` 会涨，但**成员收不到消息**（这是 dryRun 的定义）。

#### 场景 B —— 写域冲突（应跳过）

1. 任务 A：`status=in_progress`（或已被 owner 认领的 pending），写域 `src/auth`。
2. 任务 B：`ready`、无 owner，写域 `src/auth/login`。
3. 触发变化后查 status。
   - 期望：`skipped` 增加且 `scope` 那一项跟着涨；`dispatched` 不增。

#### 场景 C —— 并发预算（每轮派发数受限）

1. 建 3 个**写域各不相同**的 ready 任务 + 3 个 idle 成员。
2. 触发变化后查 status。
   - 期望：单轮 `dispatched` 增量 ≤ `maxConcurrent`（默认 2）。
3. 验证 `TeamId` 级预算：在 profile 的 `cordis.patch.yml` 的 `team-autopilot` 段加
   ```yaml
   teamBudgets:
     "<TeamId>": 1
   ```
   （`TeamId` = 团队 root 的 Session id，可从会话/日志确认），重启后重复场景，期望单轮 ≤ 1。

#### 场景 D —— 冷却去重（不重复叫同一个）

1. 触发一次变化但**不要让成员 claim**（保持 pending 无 owner）。
2. 在 `wakeCooldownMs`（默认 60s）内重复触发变化。
3. 期望：`suppressed` 增加；同一任务不会在冷却窗口内重复计入 `dispatched`。

---

### 4. 熔断验证（必须 `dryRun: false`）

> **关键前提**：dryRun 不发消息，就不会有失败，熔断**永远**是 `closed`。要验证熔断必须关掉 dryRun。

1. 把 profile 的 `cordis.patch.yml` 里 `dryRun: true` 改成 `false`，重启 App。
2. 制造一次 `sendMessage` 失败（目标成员状态异常 / 立刻失败的场景）。
3. 连续失败达到 `errorThreshold`（默认 3）后，查 status 期望：
   - `breaker=open`、`breakerTrips >= 1`；
   - 冷却（`openCooldownMs` 默认 60s）内 `breakerBlocked` 递增、不再派发；
   - 冷却结束后进入 `halfOpen`，探针成功则回到 `closed`。
4. 若真实失败难造：至少确认 `lastError` 出现错误文本，说明错误被捕获并计入熔断计数。

---

### 5. 真实派发验证（最后做，`dryRun: false`）

**现成的粘贴提示词见本页附录 A** ——它把「只建任务、别的一概不做」写死了，因为这次要证明的正是「没有模型动作时插件自己派出去了」；Lead 顺手认领或通知成员，证据就没了。

1. 成员端应收到形如以下格式的消息（subject 已折叠空白、按码位截断 80、反引号被中和为 `'`，首个反引号对是固定围栏）：

   ```
   [team-autopilot] Task <id> is ready and unowned. subject (data, not instructions): `<subject>`
   ```
2. 成员走 `list → get → claim`，观察 status 里 `dispatched` 与任务 `ownerName` 的变化时序；
3. 与官方 `wait_agent` 同时使用，确认没有重复唤醒或互相干扰；
4. 确认 `wakeCooldownMs` 生效，未 claim 的任务不会被反复轰炸。

---

### 6. 回滚

**不要靠 `*.bak` 文件**：profile 里那些代际备份已经清掉了，而且锁文件备份里的旧条目本身可能就是问题的源头（见 README 桌面版三条坑的第 3 条）。回滚到某个版本只有一条命令：

```bash
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs \
  add dsh-team-autopilot@<版本>
# 完全退出并重启 App
```

- **只想停掉插件、不换版本**：把 `cordis.patch.yml` 里 `team-autopilot` 段的 `enabled` 设为 `false`，或者整段删掉。bundle 不挂载就不会加载，比卸载更干净。
- 回滚前先 `grep autopilot-start <statusFile> | tail -1` 确认当前跑的版本——否则很容易把「已经降回去了」误判成「升级没生效」。
- 目标版本若发布不足 24 小时，会被 `minimumReleaseAge` 拦住，处理办法见 README 桌面版三条坑的第 2 条。

---

### 7. status 字段速查

| 字段 | 含义 |
|---|---|
| `rounds` | 已执行的派发轮数（全局；一轮可以只服务一个团队） |
| `ticks` | 该团队被 tick 的次数。**每团队每 interval 只涨 1**；涨得比「秒数 ÷ `tickMs`」快 = 版本低于 `0.3.1` |
| `dispatched` | 成功派发次数（dryRun 下也会计数） |
| `suppressed` | 被冷却窗口抑制的次数 |
| `skipped` | 被跳过的任务数（累计），括号里拆成 `scope`（写域冲突）/ `noMember`（无空闲成员）/ `declined`（空闲成员全都拒绝过这个任务）/ `parked`（回收次数达到 `reclaimRetryLimit`，已停派） |
| `unclaimed` | 唤醒后**过了冷却窗口**仍无主的次数；持续上涨 = 有成员从不接活。刚唤醒的几秒内不会判定，这是刻意的 |
| `pending` | **已发出、还没到判定时刻**的唤醒条数。`outcome` 只反映最近一条唤醒，一轮唤醒两个任务时，另一个只能从这里看出来 |
| `tasks` | 任务总数，**恒等于** `inFlight + claimable + blocked + done` |
| `inFlight` | 正在占用并发槽的任务：`in_progress`，或 `pending` 但已有 owner（已认领未开工） |
| `claimable` | `pending` + `ready` + 无 owner —— 该派就派的那一类 |
| `blocked` | `pending`、未 `ready`、且无 owner —— 卡在依赖上的任务 |
| `done` | `completed` 或 `deleted` |
| `idle` | 可接新活的成员数（只数 `role=teammate` 且 `inactive` 的，**不含 Lead**） |
| `slots` | 剩余并发槽（`maxConcurrent`／`teamBudgets` 减去在飞） |
| `lastReclaim` / `lastDispatch` | 最近一次回收 / 派发的详情（哪个任务、从谁到谁、叫了几次、是否被认领、多久之前）；没发生过时显式打 `none` |
| `breaker` | `closed` / `open` / `halfOpen` |
| `breakerTrips` | 熔断打开次数 |
| `breakerBlocked` | 因熔断而跳过的轮/任务数 |
| `lastError` | 最近一次错误文本 |
| `parked` | `parked=<N>`：当前被停派的任务**条目数**（不是累计次数），status 里逐条列出 `task` / `after`（第几次回收时停的）/ `lastOwner`。只停派发、不动任务板：任务仍是 `claimable`，被人或 Lead 接手、完成、或从板上消失后记录即清除；**重启插件也会清空**——这是目前唯一的人工放行路径 |
| `why` | 本轮跳过原因的集合（`scope` / `noMember` / `declined` / `parked`，无跳过时 `-`），去重排序。日志行与 status 同词；status 里是**数组**（`["declined","scope"]`，空数组等于 `-`）。前面那些 `skipped*` 是累计值，只有 `why` 回答「此刻为什么不动」；它只在原因变化时才变，所以「全员拒接、插件停手」会立刻落一行而不用等心跳 |

## 第 2 部分 · 僵死回收专项

针对 `reclaimAfterMs` / `reclaimOnFailed` 引入的僵死任务回收。挂载自检、dryRun 基础场景、熔断与真实派发见本页第 1 部分，本手册只覆盖回收。

> **先确认一件事**：`reclaimed` 涨只说明**判定成立**，不代表任务真的回了池子。回池要看任务板（`claimable` 增加、`inFlight` 减少），两者要分开验。

### 0. 观测字段

`team_autopilot_status` 输出里有两处 `reclaimed`：

```
totals rounds=N dispatched=N suppressed=N skipped=N unclaimed=N reclaimed=N parked=N
  team=<id> ... reclaimed=N unclaimed=N pending=N
    lastReclaim task=<id> from=<member> reason='<cause>' applied|dry-run (<age>)
    lastDispatch task=<id> to=<member> wakes=N sent|dry-run outcome=claimed|unclaimed|unchecked (<age>)
```

- 第一处是全局累计，第二处是按团队（多团队时逐个打印）；`totals` 里的 `parked=N` 是**当前停派任务数**，团队行括号里的 `parkedSkips=N` 才是**累计因停派而跳过**的次数
- `lastError` 非空 = **最近一次宿主调用失败**（`reassign` / `sendWake` / `waitForChange` / tick 抛错都写这里，revision 冲突最常见），**不熔断**，下一轮会重读重试；要看是哪类调用失败，配合 `lastReclaim` / `lastDispatch` 判断来源
- `outcome=unchecked` 表示**还没到判定时刻**（判定要等 `wakeCooldownMs` 到期），不是「没认领」；配合 `pending=N` 看还有几条在等判定。回收场景里它很常见：任务刚被重新派出去，判定还在冷却窗口内

**判定时务必同时看 `lastReclaim`**：`reclaimed` 只回答「几次」，`lastReclaim` 回答「哪个任务、从谁手里、为什么」。回收循环（同一任务被反复收回）只有后者能看出来——否则只能盯着任务 revision 往上爬来推断。

配套看 `lastDispatch` 的 `wakes` 与 `unclaimed`：回池后若一直没人接，`wakes` 会持续累加、`outcome=unclaimed`、`unclaimed` 递增，`unclaimed>=2` 时报告会打一行 warning。

### 1. 先把等待调短（必做）

默认 `reclaimAfterMs: 300000`（5 分钟）太慢。在 profile 的 `cordis.patch.yml` 里改：

```yaml
team-autopilot:
  reclaimAfterMs: 60000      # 1 分钟；schema 允许 1000–3600000
  reclaimOnFailed: true
```

然后**完全退出** App 再启动（不是关窗口）。

### 2. tick 节奏与时序预期

tick 由 `waitForChange(lead, tickTimeoutMs, signal)` 驱动：有团队变化立即返回，否则每 `tickTimeoutMs`（默认 30000）超时返回一次。

所以最长等待 ≈ `reclaimAfterMs + tickTimeoutMs`。按上面的配置是 **60s + 30s ≈ 90 秒内必见结果**。

两条容易踩的时序细节（`0.3.1` 起）：

- **每个团队每 interval 只 tick 一次**。一轮只服务「这一轮真的被唤醒的团队」，不会被别的团队顺带 tick。所以 N 个团队不会让某个团队的 `ticks` 变快——`ticks` 涨得比「秒数 ÷ `tickMs`」快，就说明在跑 `<0.3.1`。
- **新出现的团队最多滞后一个 interval 才有第一次 tick**（它要等自己的 waiter 到期）。看到某个团队 `ticks` 比别的团队小 1、`(…ms ago)` 也更大，这是正常的，不是漏 tick。

日志文件（`statusFile`）在这两件事上都帮不上忙：没变化的轮次不写行，只按 `statusHeartbeatMs` 打心跳。**验证时序请用 status 工具的 `ticks` 与 `(age)`，不要用日志文件的稀疏程度**。

### 3. 三个触发条件与可制造性

| 条件 | 何时回收 | 真机能造出来吗 | 依赖配置 |
|---|---|---|---|
| owner 不在 roster | 立即 | **难**——官方 9 个工具里没有移除成员的入口，只能靠进程退出 / 冷恢复失败 | 无关 |
| owner `status = failed` | 立即 | 中——需要成员启动失败 | `reclaimOnFailed` |
| owner `inactive` 满 `reclaimAfterMs` | 需跨轮累计 | **容易**——认领后不派活即可 | 无关 |

**主场景是第三条**。前两条造不出来不阻塞验证，但要如实标注"未验证"。

### 4. 场景 E —— owner inactive 超时（主场景）

1. 建一个 ready 任务 `t1`，写域与其它在飞任务不重叠。
2. 让成员 **A** 认领（A 变成 `in_progress` 的持有者），然后**不要给它派新活**、让它这一轮跑完 → A 回到 `inactive`。
3. 立刻查 status，记下 `reclaimed`（应为 0）。
   - 此时 tick 会把 `t1` 记进 stalled 表（**首轮只观察，给 grace 期**），所以这里不回收是**正确行为**，不是失败。
4. 等约 90 秒，再查 status。
   - 期望：`reclaimed` +1。
5. 看任务板：`t1` 应回到 `pending` 且 **无 owner**，`claimable` +1、`inFlight` -1。

> 想加速：把 `reclaimAfterMs` 降到 `5000`（5 秒），等待时间变成约 35 秒。验证完记得调回。

### 5. 场景 F —— 回收后不还给原 owner（核心差异）

紧接场景 E：

1. 回收发生的那一轮，任务会**重新参与派发**（`reclaim` 在 `dispatch` 之前执行，释放的槽位本轮即可复用）。
2. 团队里除 A 之外至少还有一个 idle 成员 **B**。
3. 期望：`dispatched` 也在同一轮增加，且 `t1` 派给 **B 而不是 A**。
4. 若派回了 A → `previousOwner` 避让失效，是 bug，记下 status 与日志给我。

这一条是回收与 `@nanmicoder/dsh-agent-teams` 的语义分界（它 `reassign_task` 指定新 owner = 换人，我们不带 owner = 回池重排），值得单独确认。

### 6. 场景 G —— 负向：不该回收的

| 构造 | 期望 |
|---|---|
| 成员 **running**（正在跑一轮）时持有任务，且已超过 `reclaimAfterMs` | `reclaimed` **不涨**——running 不是僵死证据 |
| 成员 **provisioning**（还没启动完）持有任务 | `reclaimed` **不涨** |
| **Lead 自己**持有的任务 | **永不回收**（`owner.role !== 'teammate'` 直接跳过） |
| 无主 `pending` 任务 | 不进回收判定（它本来就谁都能领） |

最容易误判的是第一条：成员刚被唤醒、还没开始跑的瞬间是 `inactive`，所以要靠 grace 期保护；反过来，真在跑的成员不该被抢。

### 7. 场景 H —— failed 成员（可选）

若能让某个成员进入 `failed` 状态（启动失败）：

1. 期望 `reclaimed` **立即** +1（不等 `reclaimAfterMs`）。
2. 把 `reclaimOnFailed: false` 重启后重做，期望 `reclaimed` **不涨**，任务一直挂在 `failed` 成员名下。

造不出来就跳过，并在 README「仍未验证」里留一条。

### 8. dryRun 分层（重要）

`reclaim` 在 `dryRun: true` 时**只计数、不发 `reassign`**（代码里 `continue` 掉）。所以：

| 配置 | 能验什么 | 不能验什么 |
|---|---|---|
| `dryRun: true` | 判定是否正确（`reclaimed` 涨） | 任务是否真的回池 |
| `dryRun: false` | 全部，包括真实 `reassign` 与回池后重新派发 | — |

建议**分两遍跑**：先 dryRun 确认判定，再关掉 dryRun 确认副作用。直接上 `dryRun: false` 也行，但出问题更难分辨是判定错还是写入失败。

### 9. 排查表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `reclaimed` 一直 0 | 任务 `ownerName` 为 null（未被真认领） | 确认成员真的 claim 了，不是只创建 |
| `reclaimed` 一直 0 | 成员状态不是 `inactive`（在跑 / provisioning） | 查 status 里的 `idle` 计数；等它这轮跑完 |
| `reclaimed` 一直 0 | 等得不够 | 最长 `reclaimAfterMs + tickTimeoutMs` |
| `reclaimed` 一直 0 | 插件刚重启，stalled 表已清空 | 重新等一个完整 grace 期 |
| `reclaimed` 涨了但任务没回池 | `reassign` 失败（多为 revision 冲突） | 看 `lastError`；下一轮会重读重试 |
| `reclaimed` 涨了但 breaker 也开了 | 两者独立——**回收失败不会触发熔断** | 属预期；熔断只由 `sendMessage` 连续失败驱动 |
| 回收后任务又派回 A | `previousOwner` 避让失效 | 记下 status 全文与日志，是 bug |
| `reclaimed` 一直涨、`done` 不动 | 任务被反复回收重派（`< 0.3.7` 无终点，真机 20 分钟回收 12 次 / 派发 19 次） | 升到 `0.3.7`：达到 `reclaimRetryLimit`（默认 3）后停派，日志出现 `parks=<任务><owner> after=N`、`why=parked` |

### 10. 已知限制（验证时别当成 bug）

1. **stalled 表在内存**：插件重启后所有任务的 grace 期重新计时。回收计数与停派集合同样在内存，重启即清零——停派的常规解除路径是认领 / 完成 / 删除（见下一条），重启是兜底。
2. **回收有终点（≥0.3.7）**：同一任务被回收达到 `reclaimRetryLimit`（默认 3）后不再为它唤醒任何人，进 `parked` 集合，日志 `parks=… after=N`、status 里逐条列出。**只停派发、不动任务板**：任务仍是 `claimable`，人或 Lead 认领 / 完成 / 删除它之后记录即清除。这是判断不是唤醒——反复回来说明没人能做完它，再派一次只是再烧一次 token。已真机实证（2026-10-28，0.3.7）：两个停手成员 `stall-a` / `stall-b` 让任务空转，`ticks=9/23/29` 三圈回收后 `parks=task-1<stall-a after=3`、`why=parked`，`dispatched` 冻结、日志安静。
3. **拒绝记录是任务级，不是成员级**：某任务派给某成员未被认领后，该成员在这**一个**任务上被跳过，其它任务照常派给它。若它对所有任务都不接，那些任务会各自停派（`declined` 上涨 + note 行），要恢复得让任务易手。此前「任务回池后被反复派回同一成员」的循环（真机撞到：task-3 的 revision 从 3 爬到 20，约 8–9 轮）已由此消除；循环期间仍可用 `unclaimed` / `lastDispatch wakes=N` / `lastReclaim` 三条互相印证。
4. **回收失败不熔断**：只写 `lastError`，下一轮重试。

### 11. 验证后回填

跑完后按结果更新：

- `README.md` → **真机验证记录**：补上 `reclaimed` 实测值、回收前后任务状态、是否派给了另一成员
- `README.md` → **仍未验证**：删掉已验证项，保留没造出来的场景（如 failed 成员）
- `CHANGELOG.md`：若验证中发现并修复了缺陷，记进对应版本段

## 第 3 部分 · 多团队

> 目的：确认调度器能**同时服务多个团队会话、各自独立派发**，互不串台。
>
> 历史：`0.1.1` 及以前只取第一个 Lead，桌面宿主多会话并存时会永远绑定最早那个团队、静默忽略其余；`0.1.2` 修掉。这份手册现在的作用是**回归验证**——每当改动主循环或 Lead 解析（如 `0.3.1` 的一轮只服务被唤醒团队），都值得重跑一遍。

---

### 一、前置

1. 已装当前版本（`0.3.5` 起有 `why=` / `pending=` 字段），`node scripts/verify-mount.mjs` 除 `first-run dryRun` 一项外全 PASS。
2. `cordis.patch.yml` 里 `team-autopilot.dryRun` 决定验到哪一层：
   - **只验证「调度器是否盯对团队」**：`dryRun: true` 就够（`dispatched` 会涨、`team=` 会显示正确 TeamId，只是不发消息）。
   - **想验证「真的发唤醒消息」**：把 `dryRun` 改成 `false` 再重启。
3. **完全退出并重启 App**（不是关窗口）。

---

### 二、验证步骤

#### 第 1 步：开两个团队会话

- 开**会话 A**：发一句给 Lead——「组建一个开发团队，spawn 一个成员叫 worker-a（prompt：原地待命，等 [team-autopilot] 消息再认领任务），建一个 ready 任务 task-a，writeScope 写 src/a，不要手动认领。」
- 开**会话 B**：发一句给 Lead——「组建一个开发团队，spawn 一个成员叫 worker-b（prompt：原地待命，等 [team-autopilot] 消息再认领任务），建一个 ready 任务 task-b，writeScope 写 src/b，不要手动认领。」

> 两个会话要**同时开着**，这是触发多团队场景的关键（只开一个就测不出 bug）。

#### 第 2 步：分别在两个会话里查状态

在**会话 A** 里：

```
调用 team_autopilot_status
```

在**会话 B** 里：

```
调用 team_autopilot_status
```

#### 第 3 步：对比关键字段

| 字段 | 会话 A 预期 | 会话 B 预期 |
|---|---|---|
| `team=` | 会话 A 的 TeamId | 会话 B 的 TeamId |
| `dispatched` | **≥1**（task-a 派给 worker-a） | **≥1**（task-b 派给 worker-b） |
| `tasks` | ≥1 | ≥1 |
| `claimable` | 1（或 0，取决于是否已派） | 1（或 0） |

**通过判据**：

- 会话 A 的 `team=` 是 **A 自己的 TeamId**，会话 B 的 `team=` 是 **B 自己的 TeamId**（两者不同）；
- 两个会话的 `dispatched` **都 ≥1**（各自派各自的任务）。

**这就是修复生效的铁证**：0.1.1 会「A、B 都显示同一个旧团队的 team=、dispatched 都 0」，0.1.2 会「各自独立」。

> **`0.3.1` 起多了一条判据**：每个团队每 interval 只 tick 一次。旧版（`<0.3.1`）每个团队各挂一个 waiter，任何一个到期都会触发**一整轮**并 tick 全部团队，于是 N 个团队时 `ticks` 涨到配置速率的 N 倍。
> 验法：记下某团队 `ticks` 与 `(…ms ago)`，等 2–3 分钟再查，`ticks` 增量应约等于「秒数 ÷ `tickMs`」。两个团队时看到 `ticks` 翻倍 = 还在跑旧版。

---

### 三、如果想验「真的发消息」（可选）

把 `dryRun` 改成 `false` 再重启，然后：

- 看 `worker-a` 会话是否收到 `[team-autopilot] Task task-a is ready and unowned...`；
- 看 `worker-b` 会话是否收到 `[team-autopilot] Task task-b ...`；
- 各自 `team_task_update(action=claim)` 认领 → 完成。

两个 worker 应**各收到自己团队的那条**，而不是串到对方团队。

---

### 四、记录模板（贴回给我）

```
[会话A] team_autopilot_status = ...
[会话B] team_autopilot_status = ...
[判断] 两个 team= 是否不同？两个 dispatched 是否都≥1？
```

---

### 五、失败排查

| 现象 | 含义 | 处理 |
|---|---|---|
| 两个会话 `team=` 相同 | Lead 解析又只取了一个（回归） | 先确认在跑的是当前版本（`grep autopilot-start`），再重启 App；若仍如此，把两份 status 贴出来 |
| `dispatched=0` 但 `team=` 正确 | 没有「空闲成员」或任务没 ready | 确认 worker 是 inactive、任务是 pending+ready |
| `claimable=0` | 任务已被认领（可能成员自发认领了） | 看任务 owner 是否已变，或重开干净会话 |

## 附录 A · 可直接粘贴的提示词：派发

面向**主 agent（Lead）**的指令，逐段粘贴，等它执行完再贴下一段。

**验的是哪件事**：`0.3.1` 起循环改成「一轮只服务这一轮真的被唤醒的团队」。派发本身没改，但它走的是这条新路径，上线后若没有真机跑过一次，就等于只有模拟 ctx 的集成测试在背书。

**为什么提示词要写成「什么都不要做」**：本次观测的唯一价值是——**没有任何模型动作时，插件自己把任务派出去了**。一旦 Lead 顺手认领、`send_message` 通知、或自己 spawn 一个成员去做，证据就没了，你测到的是模型，不是插件。

---

### 前提

| 条件 | 怎么确认 |
|---|---|
| 插件是 `≥0.3.5` | 日志里有 `autopilot-start version=0.3.x`；团队行里有 `why=` 与 `pending=` |
| **不是** dryRun | 启动横幅 `dryRun=false`；`status` 首行是 `autopilot active`（`dry-run` 是「只记不发」、`inactive` 是「未启用」） |
| 会话里至少 1 个空闲成员 | `team_autopilot_status` 里 `idle≥1`、`slots≥1` |
| 任务能真的被执行完 | 写域不要和其它在飞任务重叠，否则会以 `scope` 为由跳过 |

**Lead 永远不会被派发**：候选成员只取 `role === 'teammate'` 且 `status === 'inactive'` 的，Lead 既不在候选里，也不计入 `idle`。所以 `idle=1` 就是「有一个成员在等活」，不必担心把 Lead 算进去——这也意味着**一个成员都没有时，任务不会派给任何人**（`noMember` 上涨）。

---

### P1 · 建场（只建任务，别的一概不做）

```
我们要验证插件的自动派发。这一步只做一件事：建一个就绪任务，然后停下来。

1. 用 team_task_create 建 1 个任务：
   - subject: DISPATCH-TEST-01
   - description: 验证用任务，内容不重要，不需要真的实现
   - 不要设置 blockedBy（保持无依赖）
2. 用 team_task_get 查这个任务，把完整输出原样贴给我（我要看 status / ready / owner）。
3. 到此为止。不要认领、不要 send_message 通知任何成员、不要 spawn 新成员、
   不要用 wait_agent 等谁、不要替成员派活。

这次要观测的是插件自己在没有模型动作的情况下有没有派出去，任何主动帮忙都会让
观测失效。请严格执行，把任务 id 和上面那份 team_task_get 输出贴给我后结束回合。
```

记下任务 id。**发完就不要再动那个会话**，让它自己待着。

---

### 期望：四条独立证据，缺一条都不算过

| # | 证据 | 在哪看 |
|---|---|---|
| 1 | `dispatched=1`，且带 `wake=<task>>worker-<x> wakes=1` | 日志新行，或 `team_autopilot_status` |
| 2 | `claimable` 从 1 变 0，`idle` 减 1（任务被占住） | 同上 |
| 3 | 任务 `ownerName` 变成某个成员 | `team_task_get` |
| 4 | 成员收到 `[team-autopilot] Task <id> is ready and unowned. …` | 成员自己的会话 |

第 4 条是**端到端**的唯一证据：前三项都可能只证明「插件认为它派出去了」。

成员认领后下一轮会翻成 `outcome=claimed`、`inFlight=1`——这是第 5 条，顺带确认「判定」也对了。

---

### 没派出去时怎么判（任务五分桶就是拿来干这个的）

看日志里那几个字段，组合只有一种解释（先看 `why=` 指了哪一类，再用对应的计数确认）：

| 现象 | 含义 | 处理 |
|---|---|---|
| `why=scope` / `scope` 上涨 | 写域与在飞任务重叠 | 换一个不冲突的写域 |
| `why=noMember` / `idle=0` | 没有空闲成员（都忙，或团队里根本没有 teammate） | spawn 一个成员，或等一个跑完 |
| `why=declined` | 所有空闲成员都拒绝过这个任务 | **插件故意停手**，不是 bug；换成员或新建任务 |
| `blocked=1` | 任务没 ready（依赖没清） | `team_task_get` 看 `ready` / `blockedBy` |
| `slots=0` | 并发预算满了 | 提高 `maxConcurrent` 或减少在飞任务 |
| `dispatched=0` 且以上全不成立 | 派发路径真的坏了 | 把 `status` 全文 + 日志尾部贴出来 |

---

### P2 · 收尾（把任务五分桶走完一整圈）

```
让接手 DISPATCH-TEST-01 的成员把任务做完并 team_task_update 标记 completed，
然后把 team_task_get 的输出贴给我。
```

期望：`done` +1、`inFlight` 回到 0、`slots` 回满、`claimable=0`。

> 不要用 `team_task_update(action=reassign)` 手动改状态来「制造」结果——那会绕过被观测的代码路径本身。

---

### 变体：会话里没有成员

先让 Lead 建一个：

```
用 spawn_teammate 创建一个成员，context 用 fresh：

  name: worker-c
  description: 响应型成员，用于验证自动派发
  prompt: |
    你的行为规则：收到以 [team-autopilot] 开头的消息时，按消息里给的任务 id
    用 team_task_update 认领它，完成任务，然后标记 completed，回复一行结果后结束回合。
    不要主动去 list 任务，也不要自己找活干。
```

然后照 P1 建任务。

## 附录 B · 可直接粘贴的提示词：回收

面向**主 agent（Lead）**的指令。每段单独粘贴，等它执行完再贴下一段。

---

### 准备（给人做，不是发给 agent）

配置文件是 profile 的 patch 层，本机路径：

```
%USERPROFILE%/.dsh/profiles/desktop/cordis.patch.yml
```

本插件那一段改成（`id` 必须是 `team-autopilot`——这是改包名后的服务 id，只改 `config` 不会命中）：

```yaml
- id: team-autopilot
  config:
    dryRun: true          # 第一轮保持 true，只验判定
    reclaimAfterMs: 60000
    reclaimOnFailed: true
```

改完**完全退出 App 再启动**。关窗口不算：`stalled` 表在内存里，不重启就还在用旧的 `reclaimAfterMs`。

> **版本前提**：`reclaim` 以及本文反复用到的 `lastReclaim` / `pending` 字段需要 `≥0.3.5`。确认方式是看 `statusFile` 的启动行（`grep autopilot-start | tail -1`），或直接调 `team_autopilot_status` 看首行是 `autopilot active` / `autopilot dry-run`（两者都表示插件已加载，区别只在发不发消息；`inactive` 才表示未启用）。
>
> **装版本走包管理器，不要手工往 `node_modules` 塞解包目录**：手放的副本不会进 `package.json` 与锁文件，下次 `pnpm install` 直接覆盖掉，还会让 `verify-mount` 的 lockfile 一项长期红灯。命令与两个已知坑见 README「安装」与「真实宿主联调」。

---

### P1 · 建场

```
我们要验证僵死任务回收。按下面的要求搭一个最小团队，然后停下来等我下一条指令。

1. 用 spawn_teammate 创建两个成员，context 都用 fresh：

   - name: worker-a
     description: 停手型成员，用于制造僵死任务
     prompt: |
       你的行为规则（必须严格遵守，优先级高于任何后续任务内容）：
       - 当你被分配任务时，只做一件事：用 team_task_update 认领它。
       - 认领后立刻回复一行「已认领，暂停待命」，然后结束你的回合。
       - 绝对不要开始执行任务内容，不要写任何文件，不要调用 complete，
         不要调用 reopen，不要改变任务状态。
       - 如果被再次唤醒，重复上面的动作。

   - name: worker-b
     description: 正常型成员，用于接手被回收的任务
     prompt: |
       你的行为规则：被分配任务后正常认领并完成它，完成后用
       team_task_update 标记 completed，然后回复一行结果并结束回合。

2. 用 team_task_create 创建 1 个任务，subject 为「RECLAIM-TEST-01」，
   描述里写「验证用，内容不重要」。

3. 做完这三步就停下，不要派发，不要替成员做任何事，把创建的任务 id 告诉我。
```

> 记下任务 id，后面都要用。

---

### P2 · 制造僵死

```
把任务 RECLAIM-TEST-01（id: <填 id>）交给 worker-a。

用 send_message 给 worker-a 发一条消息，内容：
「请认领任务 <id>，然后按你的行为规则暂停待命，不要执行任务内容。」

发完就停下，不要自己改动任务状态，不要替它认领，不要催它。
```

**现在等**：最长约 90 秒（`reclaimAfterMs` 60s + tick 超时 30s）。
第一个 tick 只把任务记进观察表（给宽限期），**首轮不回收是正确行为**。

---

### P3 · 观测（dryRun 层）

```
调用 team_autopilot_status，把完整输出原样贴给我，不要总结。

然后用 team_task_get 查 RECLAIM-TEST-01（id: <填 id>），把 status 和 owner 原样贴给我。
```

**第一轮（dryRun: true）期望**：

| 观测点 | 期望 |
|---|---|
| `reclaimed` | ≥ 1（判定发生了） |
| 任务 status / owner | **不变**（dryRun 下只计数，不发 reassign） |
| 出现 `autopilot dry-run`（dryRun 下）或 `autopilot active`（非 dryRun 下） | 插件在跑 |

如果 `reclaimed` 一直是 0，先看 FAQ，别急着改配置。

---

### P4 · 关 dryRun，验真实副作用

改配置 `team-autopilot.dryRun: false` → 完全退出重启 → 再贴 P2（重新制造一次僵死，或直接用已僵死的那个任务）→ 等 90 秒 → 贴 P3。

**第二轮期望**：

| 观测点 | 期望 |
|---|---|
| `reclaimed` | +1 |
| 任务 status | `pending` |
| 任务 owner | **空 / null** |
| `claimable` | 回池后 +1 |
| `lastError` | 不出现（出现说明 reassign 被拒，贴给我） |

判定成功 ≠ 回池成功。**两个都要看到**才算过。

---

### P5 · 核心差异：不还给原 owner

紧接着 P4，不要干预，再等一轮 tick，然后：

```
调用 team_autopilot_status，再查 RECLAIM-TEST-01（id: <填 id>）的 status 和 owner，
把两者输出原样贴给我。
```

**期望**：任务的新 owner 是 **worker-b**（或任何不是 worker-a 的成员）。
如果又派回 worker-a —— 那是 bug，把输出贴给我，这是我们要守的语义分界（回池重排，不是还给他）。

再进一步：如果 worker-b 正常跑完，`completed` 出现，整个闭环就通了。

---

### P6 · 负向场景（不该回收的）

```
用 send_message 给 worker-b 发消息，让它认领一个新任务并**开始真正执行**
（比如让它写一个临时文件并统计行数），要确保它的回合持续较长时间。

在它执行期间，调用 team_autopilot_status 并把输出贴给我。
```

**期望**：`reclaimed` **不增加**——owner 是 `running` 时不判定僵死。

---

### P7 · 收尾

```
把团队里所有 RECLAIM-TEST-* 任务标记 deleted，然后告诉我做完了。
```

之后把配置改回你想要的 `reclaimAfterMs`（默认 300000）并重启。

---

### FAQ（agent 卡住时看这里）

| 现象 | 原因 |
|---|---|
| `reclaimed` 一直是 0，任务 owner 是空的 | 任务没被认领 → 不算 in-flight，本来就无需回收。让 worker-a 真的认领 |
| `reclaimed` 涨了但任务没变 | 这是 dryRun 的正常表现，不是失败 |
| `reclaimed` 涨了但 `lastError` 出现 | reassign 被拒（多半是 revision 冲突），把错误贴出来 |
| 等了两分钟还没动静 | 确认 App 是**完全退出后重启**的；确认 patch 里的段 id 是 `team-autopilot`，且 `reclaimAfterMs` 确实生效（对照启动行） |
| worker-a 不肯停手 | spawn 时的 prompt 没生效，重新 spawn 一个，或直接在消息里再强调一次规则 |
| 插件没加载 | 跑 `node scripts/verify-mount.mjs` |

---

### 不要做

- 不要让 Lead 自己去 claim 测试任务（Lead 持有的任务永不回收，会把场景搞乱）
- 不要在等待期间手动改任务状态
- 不要同时开别的团队插件
