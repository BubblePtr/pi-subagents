# GUI 宿主的子会话观测接口

本文面向在同一进程里嵌入 Pi SDK 的 GUI 宿主。契约定义在 [`src/host-observation.ts`](../src/host-observation.ts)，协议版本为 `1`。

子代理仍由插件使用 SDK 创建、运行、排队和管理；宿主订阅真实 `AgentSession`，把事件转换成自己的 Trace、时间线和 IPC 消息。前台与后台代理都在当前进程中运行。Workflow 的脚本使用 worker thread；它调用的子代理仍经过同一个 manager。

## 安装来源与升级

此接口基于上游 `@tintinweb/pi-subagents` **0.19.0**，基线提交为 `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`。它属于当前适配分支；上游 npm 的 `0.19.0` 本身不包含此接口。运行时应以 ready 事件的 `version` 判定支持情况。

开发时可从本地 checkout 安装，或把这个路径交给 GUI 的 Pi package 配置：

```sh
pi install /absolute/path/to/pi-subagents
```

本地路径直接引用 checkout，不复制代码。发布时应使用包含本补丁的 fork，并固定经过验证的提交：`pi install git:github.com/<owner>/pi-subagents@<commit>`。owner 和 commit 必须取自实际发布记录；本分支不冒用上游版本宣称已经发布。升级时更新这个固定提交，并同时验收宿主协议和 SDK 行为。

本补丁使用 Pi 的公开 SDK API 和 `pi.events`，不改 SDK 导出、不伪装 SDK 包名、不复制 SDK 内部 OAuth 文件，也不要求安装 Pi 二进制供子代理启动。

## 发现与订阅

根会话收到 `session_start`、按 `ctx.cwd` 加载项目配置后，会发布 `subagents:host:ready`，payload 为 `{ version: 1, rootSessionId, provider }`。`rootSessionId` 是 Pi 的根 session ID；宿主另行关联自己的 workspace 等身份。

每个根有独立 provider；同一根重复绑定使用同一个 provider。切换到另一根后，旧根的任务和会话资源先停止、释放，旧 provider 不能控制新根。

宿主必须在 ready 回调内同步订阅。`snapshot()` 只返回元数据，不补发已经错过的 session 对象或 Trace。

```ts
import type { SubagentHostReady } from "./host-observation.js";

pi.events.on("subagents:host:ready", payload => {
  const { version, rootSessionId, provider } = payload as SubagentHostReady;
  if (version !== 1) return;
  const unsubscribe = provider.subscribe(event => {
    saveRecord(rootSessionId, event.record);
    if (event.type === "session") observeSession(event.record.id, event.session);
    if (event.type === "released") releaseSessionObserver(event.record.id);
  });
  for (const record of provider.snapshot()) saveRecord(rootSessionId, record);
  retainRootController(rootSessionId, provider, unsubscribe);
});
```

示例中的保存、观测和释放函数由宿主实现。按 agent ID 和 session 对象去重：resume 会再次发布 session 事件，但复用原来的 session。

## 事件与记录

| 事件 | 含义 |
|---|---|
| `{ type: "record", record }` | 创建、排队、运行、工具活动、用量、停止或完成的状态更新 |
| `{ type: "session", record, session }` | SDK 会话已绑定工具，在首次或恢复后的 `prompt()` 之前同步发布 |
| `{ type: "released", record }` | 保留会话已清理；子会话 shutdown/dispose 后发布，record 保留最终 session 身份 |

观测从中央 manager 发出，覆盖顶层、nested、Workflow、isolated、resume 以及 `@agent` 的临时规划会话；不依赖子会话加载观察扩展。已有 `subagents:started/completed/failed/compacted` 继续采用原来的顶层过滤规则。

`record` 是可序列化快照，包括 agent/root/parent/workflow/session/toolCall 身份、类型、说明、状态、时间、结果或错误、模型、thinking level、session file、cwd、工具使用次数、当前工具和用量。初始化失败可能没有 `sessionId`。同一 agent 的 resume 复用 agent ID 和 session，更新本轮时间及状态。

`session` 和 provider 是同进程能力，不能直接发到 renderer 或持久化。宿主可用 `session.subscribe()` 获取消息、thinking、工具执行等真实事件。普通运行结束后仍可能 resume，因此不能把 `agent_end` 当成 session 销毁；收到 `released` 或根关闭后再释放订阅和引用。宿主负责持久化时间线，插件的内存 snapshot 不是历史数据库。

## 停止与关闭

| 方法 | 保证 |
|---|---|
| `stop(agentId)` | 取消该代理及所有后代，等待启动和运行真正结束，保留兄弟任务 |
| `stop()` | 同步关闭当前根的新派生入口，取消排队、运行、nested、Workflow 和临时规划工作，并等待收束；完成后允许后续新任务 |
| `steer(agentId, message)` | 向运行中的 SDK 会话发送 steer；会话尚未创建时排队保存 |
| `close()` | 幂等；永久拒绝新派生，停止全部工作并关闭保留的会话资源 |

停止中的真实运行显示 `stopping`，直到 promise 或初始化结束后才变为 `stopped`。若工具或 SDK 初始化不响应取消，stop 继续等待，不通过超时把未结束任务报告为已停止。保留会话的 extension shutdown hook 继续采用上游已有的有界清理方式。

整根停止会取消待发的完成 follow-up，避免用户停止主任务后又被子任务通知触发新一轮模型调用。单棵停止不会静音兄弟代理。插件的 `session_shutdown` 与宿主 `close()` 使用相同路径。

根会话如果正处于前台 `Agent` 工具中，应并行取消父会话和子代理，例如 `await Promise.all([parent.abort(), provider.stop()])`。宿主进程意外退出时，这些 SDK 会话随进程结束；插件不创建脱离根会话的后台进程。

## 配置与用量隔离

项目 agent 文件、settings、模型范围缓存和嵌套深度按根会话的 `ctx.cwd` 隔离；异步回调用 `AsyncLocalStorage` 恢复根作用域，不调用 `process.chdir()`。factory 尚无 session context 时只提供临时工具定义；`session_start` 重新加载真实项目并刷新工具说明/schema。严格 agent 文件校验也在此时执行，后续逐次调用重载继续只警告。

宿主 `usage` 只统计该代理自己的模型调用：新 assistant 消息，以及自己新产生的 compaction、branch summary 费用。排除 twin 继承的既有 session entries，也排除 `toolResult.usage` 中报告的子孙费用。`cost.total` 使用 SDK 原始价格结果，不自己估价。不要把已有 `record.lifetimeUsage` 或 `getSessionStats()` 的聚合总数再次加进宿主子树总额。

默认 `agentMentions: "model"` 的 `@agent` 输入会先启动临时规划会话，生成委派提示词。它显示为 `type: "mention-planner"`，说明包含委派对象和用户请求，同样发布 prompt 前 session、模型 Trace、自己的用量及工具计数。规划结束即释放临时会话，不提供可恢复的 agent handle，也不单独触发 CLI 完成通知。

规划会话通过 `Agent` 工具创建的正式子代理直接归根会话所有；规划结束不会中断已经转交的工作。根停止或关闭会取消规划初始化和模型调用、拒绝取消后的迟到工具调用，并抑制直接启动的失败回退。停止完成后可以输入新的 `@agent` 请求。此路径同样支持 headless/RPC 模式。

## 升级验收

运行 `npm run check`。新增回归在 `test/host-observation.test.ts`、`test/session-runtime-scope.test.ts`、`test/agent-startup-cancellation.test.ts` 和 `test/mention-host-lifecycle.test.ts`，保护同名项目配置隔离、prompt 前订阅、初始化取消、单棵/整根取消、前后台 resume、资源释放、默认 `@agent` 规划及正式任务转交和用量归属。GUI 还需在真实打包后的 SDK runtime 上验证发现、Trace、停止、关闭和异常退出。
