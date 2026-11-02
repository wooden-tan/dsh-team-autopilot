# 隔离测试 profile（`autopilot-lab`）

> 用途：当你把日常主线交给另一个调度插件（例如 `@nanmicoder/dsh-agent-teams`）时，
> 本插件仍然需要一个**真宿主**来做回归——独立 profile 是最干净的做法：
> 它有自己的任务板、自己的会话、自己的日志，和 desktop 互不干扰，也不需要在两边来回切开关。

为什么不能「一边跑 agent-teams、一边用本插件观察」：`@nanmicoder/dsh-agent-teams` 不注入
`ctx.agentTeams`（它 `inject` 的是 `tools`/`llm`/`subagents`/`systemPrompt`/`agents`），任务写在
`stateDir/<teamId>/team.json`。本插件只读原生 Agent Teams 服务，所以在那种用法下它只会看到空板。
要验证它，就得给它一个真正使用原生服务的宿主——也就是这个 lab profile。

---

## 1. 一次性搭建

```powershell
$cli = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'   # 装在别处就换成你的 asar 路径
$env:ELECTRON_RUN_AS_NODE = 1

# 1) 从官方 web 模板创建一个空 profile
& $cli --profile autopilot-lab --from-default-profile web --dump-config

# 2) 装本插件（开发期用 file:，测的就是工作树）
& $cli plugin --profile autopilot-lab add 'file:E:/deepseekharness/dsh-team-autopilot'
```

然后手工把**原生 Agent Teams 的 bundle 名**写进 `dsh.profile.bundles`（只写名字，不要装成依赖，见下一节）：

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-team-autopilot",
    "@deepseek-ai/dsh-experimental-agent-team-profile"
  ] } }
}
```

最后在 `%USERPROFILE%\.dsh\profiles\autopilot-lab\cordis.patch.yml` 里落一条首跑安全与独立日志：

```yaml
- id: team-autopilot
  config:
    dryRun: true
    statusFile: C:/Users/Tan11/.dsh/team-autopilot-lab.log
```

---

## 2. 两个必须知道的坑

### 坑 1：`dsh web --profile X` 会报错

CLI 的形态是 `dsh [--profile] <name>`，`web` 本身就是 profile 名。写两个就变成「选两次 profile」：

```
error: option '--profile <name>' argument 'autopilot-lab' is invalid. select a profile only once
```

正确写法是只给 profile，app 的参数直接跟在后面：

```powershell
& $cli --profile autopilot-lab --no-open
```

### 坑 2：不要把 `@deepseek-ai/dsh-experimental-agent-team-profile` 装成依赖

`dsh plugin add` 能装到的版本是 `0.1.5-alpha.2`，它要求核心包 `^0.1.5-alpha.2`，与本机
`dsh 0.2.1-rc.3` 不兼容，宿主会**禁用** `agent-team` 行，于是本插件永远停在：

```
team-autopilot (dsh-team-autopilot): pending (waiting for service: agentTeams)
```

并且控制台会重复刷 `disabling profile plugin row "agent-team" … is incompatible with dsh 0.2.1-rc.3`。
让宿主用**自带的**那份（只在 bundles 里写名字、不加依赖）即可，这也是 desktop profile 的做法。

### 坑 3：`file:` 依赖不会自己刷新，`add` 会说「Already up to date」

profile 里装的是 `file:E:/deepseekharness/dsh-team-autopilot`，但 pnpm 把它**复制**进
`node_modules/`（不是软链），并记下当时的完整性。改了源码、重建了 `dist/` 之后再跑
`dsh plugin --profile autopilot-lab add 'file:…'`，输出只有 `Already up to date`，
装进去的还是旧版本——症状是日志里 `autopilot-start version=` 停在旧号（2026-11-03 实测：
工作树 0.6.7，lab 里是 0.6.4）。

先 `remove` 再 `add` 才会重取：

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
$cli = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $cli plugin --profile autopilot-lab remove dsh-team-autopilot
& $cli plugin --profile autopilot-lab add 'file:E:/deepseekharness/dsh-team-autopilot'
```

核对装进去的那份，而不是只看命令回显：

```powershell
(Get-Content -Raw -Encoding UTF8 "$env:USERPROFILE\.dsh\profiles\autopilot-lab\node_modules\dsh-team-autopilot\package.json" | ConvertFrom-Json).version
```

### 坑 4：验证「空闲唤醒」需要一个能先空转、后创建 root 的宿主

`web` profile 要先开页面才有 agent，`headless` 的 `task` 又是在启动时就给出去——两者都
不好复现「宿主已经空闲、root 才出现」。`headless` 支持从 stdin 读任务（`-`），所以
**开着 stdin 启动、等几秒再写任务**即可：启动到写任务之间宿主没有 agent，循环已经停在
`agent/created` 上；写任务后 root 被创建，日志里的 `team=` 行就是唤醒耗时。
现成探针：`.probe/real-host-wake.mjs`（走 `autopilot-lab-hl` 这个 headless 版 lab profile）。

---

## 3. 启动与验收

```powershell
$cli = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:ELECTRON_RUN_AS_NODE = 1
& $cli --profile autopilot-lab --no-open
# 控制台会打印 dsh web: http://127.0.0.1:3080/?token=…  —— 打开这个地址就是 lab 宿主
```

验收看日志第一行（这就证明插件真的挂上了）：

```
2026-10-29T05:41:18.819Z autopilot-start version=0.6.4 … dryRun=true … reclaimMs=300000 … wakeBudget=off
```

再用挂载自检（注意 `DSH_PROFILE` 指向 lab，而不是默认的 desktop）：

```powershell
$env:DSH_PROFILE = 'C:\Users\Tan11\.dsh\profiles\autopilot-lab'
node scripts/verify-mount.mjs
# 期望：OK — 10 mount checks passed, 1 warning(s)（WARN = 日志里还没有 team 行，属正常）
```

---

## 4. 跑一次真机烟测

在 lab 宿主里（那个 `127.0.0.1:3080` 的页面）：

1. 建一个任务：subject 写清楚、description 要求「收到唤醒后 claim、回复 DONE、标记 completed、不要读写任何文件」。
2. 先不建成员，观察一次状态：应看到 `claimable=1 idle=0 why=noMember`——证明它读到了这块板。
3. `spawn_teammate` 建一个成员（context `fresh`），等它转 `inactive`。
4. 约 5–30 秒后日志应出现 `dispatched=1 … wake=<taskId>><member> wakes=1 sent=1`，
   任务变成 `completed`，再等一轮出现 `outcome=claimed`。

回收半区同理：让成员 claim 后直接结束回合不完成，等 `reclaimAfterMs` 到期，
日志应出现 `lastReclaim … reason='owner "<name>" turn ended <n>ms ago without finishing' applied`。

改完源码后：`node node_modules/tsdown/dist/run.mjs` 重建 dist，然后**重启 lab 宿主**
（`file:` 安装指向工作树，但宿主加载的是启动时那一份）。

---

## 5. 什么时候跑

- 每次改动调度/回收/卡死相关逻辑后：跑一次第 4 节（约 2 分钟）。
- 只改文案、渲染、默认值时：`tsc` + `tests/verify.ts` + `tests/integration.ts` + `verify-status` + `verify-pack` 即可，不必开 lab。
- **至少每季度一次**：因为 `tests/integration.ts` 的宿主是手写桩，真实 API 漂移它发现不了
  （历史上 `ownerName` 为 `null`、`team_task_claim` 不存在这两个真 bug 就是这么漏过去的）。
