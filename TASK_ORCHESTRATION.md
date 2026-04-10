# 任务编排系统文档

## 1. 概述

本项目实现了一套完整的**多任务编排系统**，支持本地 Agent、远程 Agent、进程内队友（Teammate）、工作流、Shell 命令等多种任务类型。系统基于 React 状态管理（`AppState`），通过统一的 `Task` 接口和 `TaskState` 状态机管理所有任务的完整生命周期。

### 核心架构

```
┌─────────────────────────────────────────────────────┐
│                    AppState                          │
│              tasks: Record<string, TaskState>        │
├─────────────────────────────────────────────────────┤
│  Task Registry (tasks.ts)                           │
│  ├── LocalAgentTask       (local_agent)             │
│  ├── InProcessTeammateTask (in_process_teammate)    │
│  ├── LocalShellTask        (local_bash)             │
│  ├── RemoteAgentTask       (remote_agent)           │
│  ├── LocalWorkflowTask     (local_workflow)         │
│  ├── MonitorMcpTask        (monitor_mcp)            │
│  └── DreamTask             (dream)                  │
├─────────────────────────────────────────────────────┤
│  Query Loop (query.ts / QueryEngine.ts)             │
│  └── callModel → stream → toolUse → runTools → loop │
├─────────────────────────────────────────────────────┤
│  Task Framework (utils/task/framework.ts)           │
│  ├── registerTask()      注册任务                    │
│  ├── updateTaskState()   更新状态                    │
│  ├── pollTasks()         轮询任务                    │
│  └── evictTerminalTask() 驱逐已完成任务              │
└─────────────────────────────────────────────────────┘
```

---

## 2. 核心类型系统

### 2.1 Task 接口 (`src/Task.ts`)

所有任务类型都实现统一的 `Task` 接口：

```typescript
type TaskType =
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_bash'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

interface Task {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

### 2.2 TaskStateBase

所有任务状态共享的基础字段：

```typescript
type TaskStateBase = {
  id: string                    // 任务唯一 ID
  type: TaskType                // 任务类型
  status: TaskStatus            // 当前状态
  description: string           // 任务描述
  startTime: number             // 开始时间
  endTime?: number              // 结束时间
  toolUseId?: string            // 关联的 tool_use ID
  outputOffset: number          // 输出偏移量（增量读取）
  notified: boolean             // 是否已发送通知
}
```

### 2.3 TaskState 联合类型 (`src/tasks/types.ts`)

```typescript
type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
```

---

## 3. 任务注册与发现

### 3.1 任务注册表 (`src/tasks.ts`)

系统维护一个全局任务注册表，通过 `TaskType` 查找对应的任务处理器：

```typescript
// src/tasks.ts
const taskMap: Record<string, Task> = { ... }

function getAllTasks(): Task[] { return Object.values(taskMap) }
function getTaskByType(type: string): Task | undefined { return taskMap[type] }
function registerNewTask(task: Task): void { taskMap[task.type] = task }
```

### 3.2 任务生命周期状态机

```
  pending ──→ running ──→ completed
                │    ──→ failed
                │    ──→ killed
                │
                └──→ (backgrounded)  // 仅 local_agent
```

---

## 4. 七种任务类型详解

### 4.1 LocalAgentTask（`local_agent`）

**文件**: `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

这是系统的核心任务类型，用于**后台 Agent 执行**。每个 LocalAgent 拥有独立的 API 会话和工具集。

**关键特性**：
- 支持前台/后台切换（`isBackgrounded` 标志）
- 拥有独立的 `AbortController`，支持父子级联中断
- 进度跟踪（`ProgressTracker`）：工具使用次数、Token 消耗、最近活动
- 消息队列（`pendingMessages`）：支持中途向 Agent 发送消息
- 自动后台化（`autoBackgroundMs`）：超时后自动转为后台任务

**注册方式**：

```typescript
// 直接后台注册
registerAsyncAgent({ agentId, description, prompt, selectedAgent, setAppState })
  → LocalAgentTaskState

// 前台注册（可后续后台化）
registerAgentForeground({ agentId, description, prompt, selectedAgent, setAppState, autoBackgroundMs })
  → { taskId, backgroundSignal: Promise<void>, cancelAutoBackground }
```

**状态转换**：

| 操作 | 函数 | 状态变化 |
|------|------|---------|
| 注册（后台） | `registerAsyncAgent()` | → running (isBackgrounded=true) |
| 注册（前台） | `registerAgentForeground()` | → running (isBackgrounded=false) |
| 后台化 | `backgroundAgentTask()` | isBackgrounded: false → true |
| 完成 | `completeAgentTask()` | → completed |
| 失败 | `failAgentTask()` | → failed |
| 终止 | `killAsyncAgent()` | → killed |
| 更新进度 | `updateAgentProgress()` | 更新 progress 字段 |
| 更新摘要 | `updateAgentSummary()` | 更新 progress.summary |

### 4.2 InProcessTeammateTask（`in_process_teammate`）

**文件**: `src/tasks/InProcessTeammateTask/`

进程内队友，运行在同一个 Node.js 进程中，使用 `AsyncLocalStorage` 实现隔离。常用于 **Swarm/Coordinator 模式**。

**关键特性**：
- 团队感知身份（`agentName@teamName`）
- 支持 Plan Mode 审批流
- 可处于 idle（等待工作）或 active（处理中）状态
- 支持消息注入（`injectUserMessageToTeammate`）
- 支持优雅关机（`shutdownRequested`）

**核心操作**：

```typescript
requestTeammateShutdown(taskId, setAppState)     // 请求关机
appendTeammateMessage(taskId, message, setAppState)  // 追加消息
injectUserMessageToTeammate(taskId, message, setAppState)  // 注入用户消息
findTeammateTaskByAgentId(agentId, tasks)         // 按 AgentID 查找
getRunningTeammatesSorted(tasks)                  // 获取排序后的运行中队友
```

### 4.3 LocalShellTask（`local_bash`）

**文件**: `src/tasks/LocalShellTask/`

用于执行本地 Shell 命令的后台任务。

### 4.4 RemoteAgentTask（`remote_agent`）

**文件**: `src/tasks/RemoteAgentTask/`

远程 Agent 任务，在远程服务器上执行。

### 4.5 LocalWorkflowTask（`local_workflow`）

**文件**: `src/tasks/LocalWorkflowTask/`

本地工作流任务，通过 Feature Flag `TEMPLATES` 控制。支持多步骤的有序执行。

### 4.6 MonitorMcpTask（`monitor_mcp`）

**文件**: `src/tasks/MonitorMcpTask/`

MCP（Model Context Protocol）服务器监控任务。

### 4.7 DreamTask（`dream`）

**文件**: `src/tasks/DreamTask/`

Dream 任务是一种特殊的后台任务类型，用于在空闲时执行自主思考、知识整理或预计算等操作。

---

## 5. 任务生命周期管理

### 5.1 任务框架 (`src/utils/task/framework.ts`)

任务框架提供统一的状态管理基础设施：

#### 注册任务

```typescript
registerTask(taskState, setAppState)
```

- 将任务状态写入 `AppState.tasks`
- 支持替换注册（恢复场景），保留 UI 状态（`retain`、`messages`、`diskLoaded`）
- 触发 SDK 事件 `task_started`

#### 更新任务状态

```typescript
updateTaskState<T>(taskId, setAppState, updater)
```

- 类型安全的状态更新
- 引用相等性检查：如果 updater 返回同一引用则跳过更新

#### 轮询任务

```typescript
pollTasks(getAppState, setAppState)
```

定期轮询所有运行中任务的输出增量：
1. 调用 `generateTaskAttachments()` 读取增量输出
2. 调用 `applyTaskOffsetsAndEvictions()` 应用更新和驱逐

#### 驱逐策略

```
PANEL_GRACE_MS = 30秒      // 面板显示宽限期
STOPPED_DISPLAY_MS = 3秒    // 已停止任务显示时间
```

- 终态任务（completed/failed/killed + notified=true）会被 GC 驱逐
- 被 UI 持有（`retain=true`）的任务不会被驱逐
- 在宽限期内（`evictAfter > Date.now()`）不会被驱逐

### 5.2 通知机制

任务完成时通过 `enqueueAgentNotification()` 发送通知：

```xml
<task_notification>
  <task_id>xxx</task_id>
  <tool_use_id>xxx</tool_use_id>
  <output_file>/path/to/output</output_file>
  <status>completed</status>
  <summary>Agent "xxx" completed</summary>
  <result>最终消息</result>
  <usage>
    <total_tokens>12345</total_tokens>
    <tool_uses>10</tool_uses>
    <duration_ms>5000</duration_ms>
  </usage>
</task_notification>
```

通知通过 `enqueuePendingNotification()` 进入消息队列，作为下一轮 API 调用的输入返回给模型。

---

## 6. Query 查询循环

### 6.1 核心循环 (`src/query.ts`)

Query 循环是系统的核心执行引擎：

```
query(params)
  └── queryLoop(params, consumedCommandUuids)
        ┌──────────────────────────────────────┐
        │  while (true)                         │
        │    ├── 消息预处理                      │
        │    │   ├── applyToolResultBudget()    │
        │    │   ├── snipCompact (可选)          │
        │    │   ├── microcompact               │
        │    │   ├── contextCollapse (可选)      │
        │    │   └── autocompact                │
        │    ├── 调用模型 (callModel)            │
        │    │   └── 流式返回 assistant messages │
        │    ├── 执行工具 (runTools)             │
        │    │   └── 并发执行所有 tool_use       │
        │    └── continue (下一轮迭代)           │
        └──────────────────────────────────────┘
```

### 6.2 QueryEngine (`src/QueryEngine.ts`)

`QueryEngine` 是更高层的协调器，负责：
- 管理 Query 循环的启动和停止
- 协调消息流和工具使用
- 处理用户中断和取消
- 与 UI 层交互

---

## 7. Agent 工具链

### 7.1 AgentTool — 创建子 Agent

**文件**: `src/tools/AgentTool/AgentTool.tsx`

当模型调用 `AgentTool` 时，系统会创建一个新的子 Agent：

```
模型调用 AgentTool(prompt, agent_type)
  ├── registerAsyncAgent() 或 registerAgentForeground()
  ├── runAgent() → 启动独立的 query() 循环
  ├── 后台 Agent: 异步运行，完成后通知
  └── 前台 Agent: 同步等待，可超时后台化
```

### 7.2 SendMessage — 向 Agent 发消息

向正在运行的后台 Agent 发送消息：

```typescript
queuePendingMessage(taskId, msg, setAppState)
```

消息在 Agent 的工具轮次边界被 drain：

```typescript
drainPendingMessages(taskId, getAppState, setAppState)
```

### 7.3 TaskStopTool — 终止任务

终止指定的任务或所有运行中的 Agent：

```typescript
killAsyncAgent(taskId, setAppState)          // 终止单个 Agent
killAllRunningAgentTasks(tasks, setAppState) // 终止所有运行中的 Agent
```

---

## 8. Coordinator 协调者模式

### 8.1 概述

Coordinator 模式是一种**多 Worker 并行编排**策略，由一个主 Agent 协调多个子 Agent 并行工作。

### 8.2 编排模式

```
用户请求
  │
  ▼
Coordinator (主 Agent)
  ├── 分析任务，拆分为子任务
  ├── spawn Agent A (research)     ──→ 并行执行
  ├── spawn Agent B (research)     ──→ 并行执行
  ├── 等待所有 Agent 完成
  ├── 综合结果
  ├── spawn Agent C (implementation) ──→ 串行执行
  └── spawn Agent D (verification)   ──→ 验证结果
```

### 8.3 进程内队友 (In-Process Teammate)

在 Coordinator 模式下，子 Agent 作为 `InProcessTeammateTask` 运行在同一进程中：

- **隔离方式**: `AsyncLocalStorage`（而非独立进程）
- **身份**: `agentName@teamName`
- **通信**: 通过 `injectUserMessageToTeammate()` 和 `pendingUserMessages`
- **生命周期**: 可处于 running、idle 或 shutdown 状态

---

## 9. 工具系统 (`src/Tool.ts`)

### 9.1 Tool 接口

```typescript
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  execute(params, context): Promise<ToolResult>
  // 可选方法
  kill?(): void
  getActivityDescription?(input): string | undefined
  backfillObservableInput?(input): void
}
```

### 9.2 工具注册 (`src/tools.ts`)

所有可用工具在 `tools.ts` 中注册，构建完整的工具列表传递给模型和 Query 循环。

---

## 10. 关键文件索引

| 文件路径 | 职责 |
|---------|------|
| `src/Task.ts` | Task 接口、TaskStateBase、TaskStatus、TaskType 定义 |
| `src/tasks.ts` | 全局任务注册表 |
| `src/tasks/types.ts` | TaskState 联合类型 |
| `src/tasks/LocalAgentTask/` | 后台 Agent 任务实现 |
| `src/tasks/InProcessTeammateTask/` | 进程内队友任务实现 |
| `src/tasks/LocalShellTask/` | Shell 命令任务 |
| `src/tasks/RemoteAgentTask/` | 远程 Agent 任务 |
| `src/tasks/LocalWorkflowTask/` | 工作流任务 |
| `src/tasks/MonitorMcpTask/` | MCP 监控任务 |
| `src/tasks/DreamTask/` | Dream 任务（空闲自主思考） |
| `src/utils/task/framework.ts` | 任务框架（注册、更新、轮询、驱逐） |
| `src/utils/task/diskOutput.ts` | 磁盘输出管理 |
| `src/utils/task/sdkProgress.ts` | SDK 进度事件 |
| `src/utils/messageQueueManager.ts` | 消息队列管理 |
| `src/query.ts` | Query 循环核心 |
| `src/QueryEngine.ts` | 查询引擎协调器 |
| `src/tools/AgentTool/` | Agent 工具（创建子 Agent） |
| `src/state/AppState.ts` | 应用全局状态 |