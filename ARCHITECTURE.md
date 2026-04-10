# free-code 源码架构解析文档

> 本文档基于 free-code v2.1.87 源码分析，旨在帮助开发者理解项目的整体架构、核心模块设计及数据流。

---

## 目录

- [free-code 源码架构解析文档](#free-code-源码架构解析文档)
  - [目录](#目录)
  - [1. 项目概述](#1-项目概述)
  - [2. 技术栈](#2-技术栈)
  - [3. 架构总览](#3-架构总览)
  - [4. 核心模块详解](#4-核心模块详解)
    - [4.1 入口与启动流程](#41-入口与启动流程)
    - [4.2 构建系统与 Feature Flag](#42-构建系统与-feature-flag)
    - [4.3 查询引擎 QueryEngine](#43-查询引擎-queryengine)
    - [4.4 命令系统](#44-命令系统)
      - [命令类型](#命令类型)
      - [命令来源](#命令来源)
      - [条件加载](#条件加载)
      - [命令过滤管道](#命令过滤管道)
      - [特殊命令集合](#特殊命令集合)
    - [4.5 工具系统](#45-工具系统)
      - [工具清单](#工具清单)
      - [工具过滤管道](#工具过滤管道)
      - [工具权限控制](#工具权限控制)
    - [4.6 终端 UI 层](#46-终端-ui-层)
    - [4.7 服务层](#47-服务层)
      - [API 客户端 (`services/api/`)](#api-客户端-servicesapi)
      - [MCP 协议 (`services/mcp/`)](#mcp-协议-servicesmcp)
      - [OAuth 认证 (`services/oauth/`)](#oauth-认证-servicesoauth)
      - [上下文压缩 (`services/compact/`)](#上下文压缩-servicescompact)
      - [其他服务](#其他服务)
    - [4.8 状态管理](#48-状态管理)
    - [4.9 技能与插件系统](#49-技能与插件系统)
      - [技能系统 (`src/skills/`)](#技能系统-srcskills)
      - [插件系统 (`src/plugins/`)](#插件系统-srcplugins)
  - [5. 数据流分析](#5-数据流分析)
    - [5.1 交互式对话的完整数据流](#51-交互式对话的完整数据流)
    - [5.2 SDK 模式 (无头模式) 数据流](#52-sdk-模式-无头模式-数据流)
  - [6. 关键设计模式](#6-关键设计模式)
    - [6.1 编译时条件导入](#61-编译时条件导入)
    - [6.2 快速路径分发](#62-快速路径分发)
    - [6.3 权限分层过滤](#63-权限分层过滤)
    - [6.4 异步生成器消息流](#64-异步生成器消息流)
    - [6.5 Memoization 缓存](#65-memoization-缓存)
  - [7. Feature Flag 体系](#7-feature-flag-体系)
    - [按可用性分类](#按可用性分类)
    - [按功能分类（可用 Flag）](#按功能分类可用-flag)
      - [交互与 UI](#交互与-ui)
      - [代理、记忆与规划](#代理记忆与规划)
      - [工具与基础设施](#工具与基础设施)
    - [Flag 工作原理](#flag-工作原理)
  - [8. 目录结构速查](#8-目录结构速查)
  - [9. 多模型提供商架构](#9-多模型提供商架构)
  - [10. 总结](#10-总结)

---

## 1. 项目概述

**free-code** 是 Anthropic [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 的社区构建分支。上游源码通过 npm 分发包中的 source map 暴露后被重建。与上游相比，free-code 做了三方面的修改：

1. **移除遥测** — 所有 OpenTelemetry/gRPC、GrowthBook 分析、Sentry 错误报告均被消除或替换为桩代码
2. **移除安全提示护栏** — 去除了 CLI 层注入的额外提示限制（模型自身安全训练不受影响）
3. **解锁实验特性** — 88 个 Feature Flag 中有 54 个被编译通过并启用

本质上，这是一个**终端原生的 AI 编码代理**，支持多模型提供商（Anthropic/OpenAI/Bedrock/Vertex/Foundry），通过交互式 REPL 或 SDK 模式运行。

---

## 2. 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| **运行时** | [Bun](https://bun.sh) >= 1.3.11 | 同时作为运行时和打包器 |
| **语言** | TypeScript | ES Module 模式 |
| **终端 UI** | React 19 + [Ink 6](https://github.com/vadimdemedes/ink) | 用 React 组件模型渲染终端界面 |
| **CLI 解析** | [Commander.js](https://github.com/tj/commander.js) | 处理命令行参数和子命令 |
| **Schema 验证** | Zod v4 | 参数校验 |
| **代码搜索** | ripgrep (内嵌) | 文件搜索后端 |
| **协议** | MCP, LSP | 工具协议与语言服务协议 |
| **API** | Anthropic Messages API, OpenAI Codex, AWS Bedrock, Google Vertex AI | 多提供商支持 |
| **可观测性** | OpenTelemetry (已移除/桩化) | 原生用于遥测，现为空操作 |

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        用户界面层                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  REPL.tsx   │  │  Components  │  │  Screens/Doctor    │  │
│  │ (主交互UI)  │  │ (Ink组件库)  │  │  (诊断/恢复)       │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────────────┘  │
│         │                │                                    │
├─────────┼────────────────┼────────────────────────────────────┤
│         ▼                ▼         命令/工具注册层            │
│  ┌──────────────┐  ┌──────────────┐                          │
│  │ commands.ts  │  │  tools.ts    │                          │
│  │ (斜杠命令)   │  │ (Agent工具)  │                          │
│  └──────┬───────┘  └──────┬───────┘                          │
│         │                 │                                   │
├─────────┼─────────────────┼──────────────────────────────────┤
│         ▼                 ▼         核心引擎层               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                  QueryEngine.ts                       │    │
│  │  (对话生命周期管理 / 消息流 / 工具调用 / 会话持久化)  │    │
│  └──────────────────────┬───────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────┼───────────────────────────────┐    │
│  │              query.ts (查询管道)                       │    │
│  │  系统提示构建 → API调用 → 流式响应 → 工具执行循环    │    │
│  └──────────────────────┬───────────────────────────────┘    │
│                         │                                    │
├─────────────────────────┼────────────────────────────────────┤
│                         ▼         服务层                     │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐ │
│  │ services/  │ │ services/  │ │ services │ │ services/  │ │
│  │ api/       │ │ oauth/     │ │ /mcp/    │ │ compact/   │ │
│  │ (API客户端)│ │ (认证流程) │ │ (MCP协议)│ │ (上下文压缩)│ │
│  └────────────┘ └────────────┘ └──────────┘ └────────────┘ │
│                                                             │
├──────────────────────────────────────────────────────────────┤
│                      基础设施层                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐ │
│  │ state/   │ │ hooks/   │ │ utils/   │ │ skills/plugins │ │
│  │ (状态)   │ │ (React   │ │ (工具库) │ │ (扩展系统)     │ │
│  │          │ │  Hooks)  │ │          │ │                │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 核心模块详解

### 4.1 入口与启动流程

**文件**: `src/entrypoints/cli.tsx`

这是整个 CLI 的入口点，采用**快速路径分发**模式（Fast-path dispatch），通过动态导入实现最小化模块加载：

```
用户执行 ./cli [参数]
        │
        ▼
    main() 函数
        │
        ├── 参数 === --version/-v?
        │   └── 直接输出版本号 (零模块导入)
        │
        ├── 参数 === --dump-system-prompt?
        │   └── 加载配置 → 构建系统提示 → 输出并退出
        │
        ├── 参数 === --claude-in-chrome-mcp?
        │   └── 启动 Chrome MCP 服务器
        │
        ├── 参数 === --computer-use-mcp? (需要 CHICAGO_MCP Flag)
        │   └── 启动 Computer Use MCP 服务器
        │
        ├── 参数 === --daemon-worker? (需要 DAEMON Flag)
        │   └── 启动守护进程 Worker
        │
        ├── 参数 === remote-control/rc/remote/sync/bridge? (需要 BRIDGE_MODE Flag)
        │   └── 认证检查 → GrowthBook 权限检查 → 策略限制检查 → 启动 Bridge
        │
        ├── 参数 === ps/logs/attach/kill? (需要 BG_SESSIONS Flag)
        │   └── 会话管理 (后台任务)
        │
        ├── 参数 === new/list/reply? (需要 TEMPLATES Flag)
        │   └── 模板任务处理
        │
        ├── 包含 --tmux + --worktree?
        │   └── exec 到 tmux worktree 环境
        │
        └── 其他: 启动完整 CLI
            └── 捕获早期输入 → 导入 main.tsx → 启动交互式 REPL
```

**关键设计**:
- 所有 `feature('FLAG')` 调用在构建时通过 Bun 的死代码消除（DCE）被静态移除
- 动态 `import()` 确保 `--version` 等快速路径几乎零模块加载
- `startCapturingEarlyInput()` 在加载主模块前开始捕获用户输入，减少感知延迟

### 4.2 构建系统与 Feature Flag

**文件**: `scripts/build.ts`

构建系统是 free-code 最核心的基础设施之一，实现了**编译时 Feature Flag 消除**机制：

```typescript
// 构建时通过 --feature=FLAG 参数传入
// Bun bundler 将 feature('FLAG') 替换为 true/false
// 然后通过 DCE (Dead Code Elimination) 移除不可达代码

if (feature('ULTRAPLAN')) {
  // 当 Flag 开启时，这段代码保留
  const ultraplan = require('./commands/ultraplan.js')
}
// 当 Flag 关闭时，整个 if 块被消除
```

**构建变体**:

| 命令 | 输出 | 启用的 Feature Flags |
|------|------|---------------------|
| `bun run build` | `./cli` | 仅 `VOICE_MODE` |
| `bun run build:dev` | `./cli-dev` | 仅 `VOICE_MODE` (开发版标记) |
| `bun run build:dev:full` | `./cli-dev` | 所有 54 个可用 Flags |
| `bun run compile` | `./dist/cli` | 仅 `VOICE_MODE` |
| `bun run dev` | 直接运行源码 | 全部动态加载 |

**MACRO 全局变量**: 构建时注入版本号、构建时间、包 URL 等信息：
```typescript
MACRO = {
  VERSION: '2.1.87',
  BUILD_TIME: '2026-03-31T...',
  PACKAGE_URL: 'claude-code-source-snapshot',
  FEEDBACK_CHANNEL: 'github',
}
```

### 4.3 查询引擎 QueryEngine

**文件**: `src/QueryEngine.ts`

`QueryEngine` 是整个对话系统的核心，管理从用户输入到 LLM 响应的完整生命周期：

```typescript
class QueryEngine {
  // 配置
  private config: QueryEngineConfig
  // 可变消息历史
  private mutableMessages: Message[]
  // 中止控制器
  private abortController: AbortController
  // 权限拒绝记录
  private permissionDenials: SDKPermissionDenial[]
  // 累计使用量
  private totalUsage: NonNullableUsage
  // 文件读取状态缓存
  private readFileState: FileStateCache
}
```

**核心流程** (`submitMessage` 方法):

```
submitMessage(prompt)
    │
    ├── 1. 构建系统提示
    │   ├── fetchSystemPromptParts() → 获取默认提示/用户上下文/系统上下文
    │   ├── 加载记忆提示 (MEMORY.md)
    │   └── 组合: [默认/自定义提示] + [记忆] + [追加提示]
    │
    ├── 2. 处理用户输入
    │   ├── processUserInput() → 解析斜杠命令、附件等
    │   └── 返回: messages, shouldQuery, allowedTools, model
    │
    ├── 3. 会话持久化
    │   ├── 预写入 transcript (使 kill 后可恢复)
    │   └── --bare 模式下 fire-and-forget
    │
    ├── 4. 加载技能和插件
    │   ├── getSlashCommandToolSkills()
    │   └── loadAllPluginsCacheOnly()
    │
    ├── 5. yield systemInitMessage (SDK 消息)
    │
    ├── 6. 如果 shouldQuery = true → 进入查询循环
    │   │
    │   └── for await (message of query({...})) →
    │       ├── assistant 消息 → 持久化 + yield
    │       ├── user 消息 → 持久化 + yield
    │       ├── progress 消息 → 持久化 + yield
    │       ├── stream_event → 更新 usage / yield (可选)
    │       ├── attachment → 处理结构化输出 / 最大轮次
    │       ├── system 消息 → 处理 compact boundary / API 错误
    │       └── tool_use_summary → yield
    │
    └── 7. yield result 消息 (成功/错误/预算超限)
```

**关键设计**:
- **AsyncGenerator 模式**: `submitMessage` 是异步生成器，允许调用方以流式方式消费消息
- **SDK 与 REPL 双模式**: QueryEngine 同时服务于 SDK（无头）模式和 REPL（交互）模式
- **内存管理**: compact_boundary 后会截断 `mutableMessages` 释放旧消息的内存
- **transcript 可恢复性**: 在进入查询循环前就持久化用户消息，确保进程被 kill 后可恢复

### 4.4 命令系统

**文件**: `src/commands.ts`

命令系统管理所有斜杠命令（如 `/help`、`/compact`、`/model` 等），采用**分层注册 + 条件加载**模式：

#### 命令类型

```typescript
type Command = 
  | { type: 'local', name: string, ... }        // 本地执行，返回文本
  | { type: 'local-jsx', name: string, ... }    // 本地执行，渲染 Ink UI
  | { type: 'prompt', name: string, ... }       // 展开为提示文本发送给模型
```

#### 命令来源

| 来源 | 说明 | 示例 |
|------|------|------|
| `builtin` | 硬编码的内置命令 | `/help`, `/clear`, `/compact` |
| `bundled` | 打包的技能 | 内置技能模板 |
| `skills` | 从 `.claude/skills/` 加载 | 用户自定义技能 |
| `commands_DEPRECATED` | 从 `.claude/commands/` 加载 | 旧式自定义命令 |
| `plugin` | 从插件加载 | 社区/官方插件 |
| `mcp` | 从 MCP 服务器加载 | MCP 提供的命令 |
| `workflow` | 工作流脚本 | 自动化工作流 |

#### 条件加载

许多命令通过 `feature()` 或 `process.env` 进行条件加载：

```typescript
// Feature Flag 控制的命令
const ultraplan = feature('ULTRAPLAN') ? require('./commands/ultraplan.js') : null
const voiceCommand = feature('VOICE_MODE') ? require('./commands/voice/index.js') : null
const bridge = feature('BRIDGE_MODE') ? require('./commands/bridge/index.js') : null

// 环境变量控制
const agentsPlatform = process.env.USER_TYPE === 'ant' ? require(...) : null
```

#### 命令过滤管道

```
getCommands(cwd)
    │
    ├── loadAllCommands(cwd)  [memoized]
    │   ├── getSkills() → skillDir + pluginSkills + bundledSkills + builtinPluginSkills
    │   ├── getPluginCommands()
    │   └── getWorkflowCommands() (如果 WORKFLOW_SCRIPTS Flag 启用)
    │
    ├── getDynamicSkills() → 运行时动态发现的技能
    │
    └── 过滤:
        ├── meetsAvailabilityRequirement() → 按认证状态过滤
        ├── isCommandEnabled() → 按 Flag/配置过滤
        └── 去重动态技能
```

#### 特殊命令集合

- **`INTERNAL_ONLY_COMMANDS`**: 仅 Anthropic 内部使用的命令（如 `backfill-sessions`、`mock-limits`）
- **`REMOTE_SAFE_COMMANDS`**: 远程模式下安全的命令（`/session`、`/exit`、`/clear` 等）
- **`BRIDGE_SAFE_COMMANDS`**: 通过 Remote Control 桥接可执行的本地命令

### 4.5 工具系统

**文件**: `src/tools.ts`

工具系统管理所有 Agent 可调用的工具（如 `Bash`、`FileRead`、`FileEdit` 等），是 Claude 与环境交互的核心接口。

#### 工具清单

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件操作** | `FileReadTool`, `FileEditTool`, `FileWriteTool`, `NotebookEditTool` | 文件读写编辑 |
| **搜索** | `GlobTool`, `GrepTool` | 文件搜索与内容搜索 |
| **执行** | `BashTool`, `PowerShellTool` | Shell 命令执行 |
| **网络** | `WebFetchTool`, `WebSearchTool` | 网络访问与搜索 |
| **代理** | `AgentTool` | 子代理调用 |
| **任务** | `TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, `TaskListTool`, `TaskOutputTool`, `TaskStopTool` | 任务管理 (v2) |
| **计划** | `EnterPlanModeTool`, `ExitPlanModeV2Tool` | 规划模式 |
| **Worktree** | `EnterWorktreeTool`, `ExitWorktreeTool` | Git Worktree 管理 |
| **MCP** | `ListMcpResourcesTool`, `ReadMcpResourceTool` | MCP 资源访问 |
| **协作** | `SendMessageTool`, `TeamCreateTool`, `TeamDeleteTool` | 多代理协作 |
| **记忆** | `TodoWriteTool` | 待办事项管理 |
| **其他** | `SkillTool`, `ToolSearchTool`, `AskUserQuestionTool`, `BriefTool` 等 | 技能/搜索/交互 |

#### 工具过滤管道

```
assembleToolPool(permissionContext, mcpTools)
    │
    ├── getTools(permissionContext)
    │   │
    │   ├── CLAUDE_CODE_SIMPLE 模式?
    │   │   ├── REPL 模式 → [REPLTool] + 协调器工具
    │   │   └── 普通 → [BashTool, FileReadTool, FileEditTool] + 协调器工具
    │   │
    │   └── 完整模式
    │       ├── getAllBaseTools() → 获取所有内置工具
    │       ├── filterToolsByDenyRules() → 按权限拒绝规则过滤
    │       ├── REPL 模式 → 隐藏 REPL_ONLY_TOOLS
    │       └── isEnabled() 检查 → 按工具自身 isEnabled() 过滤
    │
    └── 合并 MCP 工具
        ├── filterToolsByDenyRules() → 过滤被拒绝的 MCP 工具
        ├── 按名称排序 (缓存稳定性)
        └── uniqBy('name') → 去重 (内置优先)
```

#### 工具权限控制

每个工具调用都需要通过 `canUseTool` 回调进行权限检查：

```typescript
canUseTool(tool, input, context, message, toolUseID, forceDecision)
    → { behavior: 'allow' | 'deny' | 'ask', ... }
```

权限模式包括：
- **自动允许**: 基于规则的白名单（如只读文件操作）
- **询问用户**: 需要用户确认（如执行 bash 命令）
- **拒绝**: 明确拒绝的工具操作

### 4.6 终端 UI 层

**核心文件**: `src/screens/REPL.tsx` (主交互界面), `src/components/` (组件库)

UI 层使用 **React + Ink** 构建，将终端渲染为类似 Web 的组件树：

```
REPL.tsx (主屏幕)
├── TextInput / VimTextInput (用户输入)
├── Messages (消息列表)
│   └── MessageRow → Message → MessageResponse
│       ├── Markdown (Markdown 渲染)
│       ├── HighlightedCode (代码高亮)
│       └── StructuredDiff / StructuredDiffList (差异显示)
├── StatusLine (状态栏)
├── ToolUseLoader (工具执行加载器)
├── ModelPicker (模型选择器)
├── TokenWarning (Token 用量警告)
├── 各种对话框组件
│   ├── AutoModeOptInDialog
│   ├── BridgeDialog
│   ├── MCPServerApprovalDialog
│   ├── CostThresholdDialog
│   └── ...
└── VirtualMessageList (虚拟滚动列表)
```

**关键 UI 特性**:
- **虚拟列表渲染** (`VirtualMessageList`): 高效渲染大量消息
- **Vim 模式** (`VimTextInput`): 支持 Vim 键绑定
- **Markdown 渲染** (`Markdown.tsx`): 终端中渲染 Markdown，包括代码高亮
- **主题系统** (`ThemePicker`): 多种终端配色方案
- **快捷键系统** (`src/keybindings/`): 可自定义的键绑定

### 4.7 服务层

**目录**: `src/services/`

服务层包含多个独立的子系统：

#### API 客户端 (`services/api/`)
- `claude.ts`: Anthropic Messages API 客户端，处理流式响应
- 支持 OpenAI Codex、AWS Bedrock、Google Vertex AI、Anthropic Foundry 等多种后端
- 内置重试逻辑、速率限制处理

#### MCP 协议 (`services/mcp/`)
- Model Context Protocol 实现
- 管理与外部 MCP 服务器的连接
- 工具注册、资源发现

#### OAuth 认证 (`services/oauth/`)
- Anthropic OAuth 流程
- OpenAI OAuth 流程 (Codex)
- Token 刷新管理

#### 上下文压缩 (`services/compact/`)
- 自动/手动上下文压缩
- 当对话历史过长时，自动压缩早期消息
- `compact_boundary` 系统消息标记压缩边界

#### 其他服务
- `services/extractMemories/`: 从对话中提取记忆
- `services/SessionMemory/`: 会话记忆管理
- `services/teamMemorySync/`: 团队记忆同步
- `services/policyLimits/`: 组织策略限制
- `services/settingsSync/`: 设置同步
- `services/voice.ts`: 语音输入服务

### 4.8 状态管理

**目录**: `src/state/`

应用使用集中式状态存储（`AppState`），通过 React 的 `useState`/`useReducer` 模式管理：

```typescript
type AppState = {
  // 消息历史
  messages: Message[]
  // 工具权限上下文
  toolPermissionContext: ToolPermissionContext
  // 文件历史状态
  fileHistory: FileHistoryState
  // 归因状态
  attribution: AttributionState
  // 快速模式
  fastMode: boolean
  // MCP 状态
  mcp: { tools: Tools, commands: Command[], ... }
  // ... 更多状态
}
```

状态通过 `getAppState()` 和 `setAppState()` 在工具上下文中传递，允许工具和命令修改全局状态。

### 4.9 技能与插件系统

#### 技能系统 (`src/skills/`)

技能是一种特殊的命令，展开为提示文本发送给模型：

```
技能来源:
├── .claude/skills/ 目录下的 Markdown 文件
├── 内置技能 (bundledSkills)
├── 插件提供的技能
├── MCP 服务器提供的技能
└── 动态发现的技能 (文件操作触发)
```

技能文件格式：
```markdown
---
name: my-skill
description: 描述信息
whenToUse: 何时使用此技能
---

技能的提示内容...
```

#### 插件系统 (`src/plugins/`)

插件可以扩展 Claude Code 的功能：
- 注册新的斜杠命令
- 提供技能
- 添加 MCP 工具

---

## 5. 数据流分析

### 5.1 交互式对话的完整数据流

```
用户输入 "帮我修复这个 bug"
    │
    ▼
┌─── REPL.tsx ──────────────────────────────────────────┐
│ TextInput 捕获输入                                     │
│ └── processUserInput() 处理                            │
│     ├── 检查是否为斜杠命令                              │
│     ├── 检查是否包含附件 (@file)                        │
│     └── 构造 User Message                              │
└───────────────┬───────────────────────────────────────┘
                │
                ▼
┌─── QueryEngine.submitMessage() ───────────────────────┐
│ 1. 构建 System Prompt                                  │
│    ├── fetchSystemPromptParts()                        │
│    │   ├── 工具描述列表                                │
│    │   ├── 用户上下文 (CLAUDE.md 等)                   │
│    │   └── 系统上下文                                  │
│    └── 组合最终提示                                    │
│                                                        │
│ 2. 持久化用户消息到 transcript                         │
│                                                        │
│ 3. 调用 query() 进入查询循环                           │
│    ├── 构建请求参数                                    │
│    ├── 调用 Anthropic/OpenAI/Bedrock API               │
│    │                                                   │
│    │   ┌── API 响应 ──────────────────────────────┐   │
│    │   │ 流式返回 content blocks:                 │   │
│    │   │ ├── text → 文本响应 → yield 给 REPL      │   │
│    │   │ ├── tool_use → 工具调用请求              │   │
│    │   │ └── thinking → 思考过程                  │   │
│    │   └─────────────────────────────────────────┘   │
│    │                                                   │
│    └── 工具调用循环:                                   │
│        ├── 解析 tool_use 块                            │
│        ├── canUseTool() 权限检查                       │
│        │   ├── allow → 执行工具                       │
│        │   ├── ask → 提示用户确认                     │
│        │   └── deny → 返回拒绝结果                    │
│        ├── 执行工具 (如 BashTool.execute())            │
│        ├── 构造 tool_result 消息                       │
│        └── 再次调用 API (带 tool_result)               │
│                                                        │
│ 4. 消息处理与 yield                                    │
│    ├── assistant → 渲染到终端                          │
│    ├── progress → 显示进度                             │
│    ├── stream_event → 更新 token 计数                  │
│    └── system → 处理压缩边界/API错误                   │
│                                                        │
│ 5. 结束 → yield result (包含费用/使用量统计)           │
└───────────────────────────────────────────────────────┘
```

### 5.2 SDK 模式 (无头模式) 数据流

SDK 模式下，外部程序通过 `QueryEngine` 的 AsyncGenerator 接口消费消息：

```typescript
const engine = new QueryEngine(config)

for await (const message of engine.submitMessage(prompt)) {
  switch (message.type) {
    case 'assistant': // 助手响应
    case 'user':      // 用户消息回放
    case 'stream_event': // 流式事件
    case 'tool_use_summary': // 工具使用摘要
    case 'result':    // 最终结果
  }
}
```

---

## 6. 关键设计模式

### 6.1 编译时条件导入

free-code 大量使用 `feature()` + `require()` 模式实现编译时条件导入：

```typescript
// 这些 require() 只在对应 Flag 启用时才被打包
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null

const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null
```

当 `feature('FLAG')` 返回 `false` 时，Bun 的 DCE 会消除整个分支，`require()` 永远不会出现在最终包中。

### 6.2 快速路径分发

入口点 `cli.tsx` 采用快速路径分发模式，优先检查不需要完整模块加载的场景：

```typescript
// 最快的路径: 零模块导入
if (args[0] === '--version') {
  console.log(MACRO.VERSION)
  return
}

// 其他快速路径: 最小化动态导入
if (args[0] === 'remote-control') {
  const { bridgeMain } = await import('../bridge/bridgeMain.js')
  await bridgeMain(args)
  return
}

// 默认: 加载完整 CLI
const { main: cliMain } = await import('../main.js')
await cliMain()
```

### 6.3 权限分层过滤

工具权限经过多层过滤：

1. **编译时过滤**: 通过 `feature()` Flag 在构建时移除不存在的工具
2. **拒绝规则过滤**: `filterToolsByDenyRules()` 根据配置 blanket-deny 工具
3. **运行时权限检查**: `canUseTool()` 在每次工具调用时检查权限
4. **可用性检查**: `meetsAvailabilityRequirement()` 按认证状态过滤命令

### 6.4 异步生成器消息流

整个查询管道基于 AsyncGenerator 构建，允许流式处理和提前终止：

```typescript
async function* query(options): AsyncGenerator<Message> {
  // yield 各种类型的消息
  yield { type: 'assistant', message: ... }
  yield { type: 'progress', ... }
  yield { type: 'stream_event', event: ... }
  // ...
}
```

### 6.5 Memoization 缓存

命令加载使用 `lodash-es/memoize` 进行缓存，避免重复的磁盘 I/O：

```typescript
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  // 昂贵的操作: 磁盘 I/O + 动态导入
  ...
})
```

缓存可通过 `clearCommandsCache()` 手动清除。

---

## 7. Feature Flag 体系

free-code 有 88 个 Feature Flag，分为以下几类：

### 按可用性分类

| 状态 | 数量 | 说明 |
|------|------|------|
| ✅ 编译通过 | 54 | 可以正常打包 |
| ❌ 编译失败 | 34 | 缺少依赖模块或资源 |

### 按功能分类（可用 Flag）

#### 交互与 UI
- `ULTRAPLAN` — 远程多代理规划
- `ULTRATHINK` — 深度思考模式
- `VOICE_MODE` — 语音输入
- `TOKEN_BUDGET` — Token 预算追踪
- `HISTORY_PICKER` — 历史提示选择器
- `MESSAGE_ACTIONS` — 消息操作入口
- `QUICK_SEARCH` — 快速搜索

#### 代理、记忆与规划
- `BUILTIN_EXPLORE_PLAN_AGENTS` — 内置探索/规划代理
- `VERIFICATION_AGENT` — 验证代理
- `AGENT_TRIGGERS` — 本地 cron/触发器工具
- `EXTRACT_MEMORIES` — 自动记忆提取
- `TEAMMEM` — 团队记忆

#### 工具与基础设施
- `BRIDGE_MODE` — IDE 远程控制桥
- `BASH_CLASSIFIER` — Bash 权限分类器
- `PROMPT_CACHE_BREAK_DETECTION` — 缓存破坏检测

### Flag 工作原理

```
1. 构建时: bun build --feature=ULTRAPLAN ...
      ↓
2. Bun bundler 定义: feature('ULTRAPLAN') → true
      ↓
3. 死代码消除: 
   if (true) { ... } → 保留
   if (false) { ... } → 移除
      ↓
4. 最终二进制: 只包含启用的功能代码
```

---

## 8. 目录结构速查

```
free-code/
├── scripts/
│   └── build.ts              # 构建脚本 + Feature Flag 打包器
│
├── src/
│   ├── entrypoints/
│   │   └── cli.tsx           # CLI 入口点 (快速路径分发)
│   │
│   ├── main.tsx              # 完整 CLI 主函数
│   ├── QueryEngine.ts        # 查询引擎 (对话生命周期)
│   ├── query.ts              # 查询管道 (API 调用循环)
│   ├── commands.ts           # 斜杠命令注册中心
│   ├── tools.ts              # Agent 工具注册中心
│   ├── Tool.ts               # Tool 基类与接口
│   ├── Task.ts               # Task 类型定义
│   ├── tasks.ts              # 任务系统
│   │
│   ├── screens/              # 屏幕级组件
│   │   ├── REPL.tsx          # 主交互式 REPL
│   │   ├── Doctor.tsx        # 诊断工具
│   │   └── ResumeConversation.tsx  # 恢复对话
│   │
│   ├── components/           # 100+ Ink/React UI 组件
│   │   ├── App.tsx           # 应用根组件
│   │   ├── TextInput.tsx     # 输入框
│   │   ├── Messages.tsx      # 消息列表
│   │   ├── Markdown.tsx      # Markdown 渲染
│   │   ├── Message.tsx       # 单条消息渲染
│   │   ├── StatusLine.tsx    # 状态栏
│   │   ├── ModelPicker.tsx   # 模型选择
│   │   └── ...               # 对话框/指示器/选择器等
│   │
│   ├── commands/             # 斜杠命令实现 (50+ 命令)
│   │   ├── help/             # /help
│   │   ├── compact/          # /compact (上下文压缩)
│   │   ├── config/           # /config
│   │   ├── mcp/              # /mcp (MCP 管理)
│   │   ├── model/            # /model (模型切换)
│   │   ├── login/            # /login (认证)
│   │   ├── skills/           # /skills
│   │   ├── agents/           # /agents
│   │   └── ...
│   │
│   ├── tools/                # Agent 工具实现 (40+ 工具)
│   │   ├── BashTool/         # Shell 命令执行
│   │   ├── FileReadTool/     # 文件读取
│   │   ├── FileEditTool/     # 文件编辑
│   │   ├── FileWriteTool/    # 文件写入
│   │   ├── GlobTool/         # 文件模式搜索
│   │   ├── GrepTool/         # 内容搜索
│   │   ├── AgentTool/        # 子代理调用
│   │   ├── WebFetchTool/     # URL 获取
│   │   ├── WebSearchTool/    # 网络搜索
│   │   ├── MCPTool/          # MCP 工具桥接
│   │   ├── SkillTool/        # 技能调用
│   │   └── ...
│   │
│   ├── services/             # 服务层
│   │   ├── api/              # API 客户端 (Anthropic/OpenAI/Bedrock/Vertex)
│   │   ├── oauth/            # OAuth 认证流程
│   │   ├── mcp/              # MCP 协议实现
│   │   ├── compact/          # 上下文压缩服务
│   │   ├── extractMemories/  # 记忆提取
│   │   ├── SessionMemory/    # 会话记忆
│   │   ├── analytics/        # 分析 (桩化)
│   │   └── ...
│   │
│   ├── state/                # 应用状态
│   │   └── AppState          # 集中式状态定义
│   │
│   ├── hooks/                # React Hooks
│   │   └── useCanUseTool.js  # 工具权限检查 Hook
│   │
│   ├── skills/               # 技能系统
│   │   ├── bundledSkills.ts  # 内置技能
│   │   └── loadSkillsDir.ts  # 从目录加载技能
│   │
│   ├── plugins/              # 插件系统
│   │   ├── builtinPlugins.ts # 内置插件
│   │   └── pluginLoader.ts   # 插件加载器
│   │
│   ├── bridge/               # IDE 桥接
│   │   └── bridgeMain.js     # Remote Control 主函数
│   │
│   ├── voice/                # 语音输入
│   │
│   ├── coordinator/          # 协调器模式 (多代理)
│   │
│   ├── memdir/               # 记忆目录管理 (MEMORY.md)
│   │
│   ├── constants/            # 常量与系统提示
│   │   └── prompts.ts        # 系统提示模板
│   │
│   ├── utils/                # 工具库
│   │   ├── model/            # 模型配置与验证
│   │   ├── permissions/      # 权限系统
│   │   ├── config.ts         # 配置管理
│   │   ├── auth.ts           # 认证工具
│   │   ├── processUserInput/ # 用户输入处理
│   │   └── ...
│   │
│   ├── types/                # TypeScript 类型定义
│   │   ├── message.ts        # 消息类型
│   │   ├── command.ts        # 命令类型
│   │   └── ...
│   │
│   ├── schemas/              # Zod Schema 定义
│   │
│   ├── migrations/           # 数据迁移
│   │
│   ├── keybindings/          # 快捷键系统
│   │
│   ├── outputStyles/         # 输出样式
│   │
│   ├── vim/                  # Vim 模式实现
│   │
│   └── ink/                  # Ink 定制扩展
│
├── package.json              # 项目配置 (Bun workspace)
├── tsconfig.json             # TypeScript 配置
├── FEATURES.md               # Feature Flag 审计文档
└── AGENTS.md                 # AI 代理指南
```

---

## 9. 多模型提供商架构

free-code 支持五种 API 提供商，通过环境变量切换：

```
┌─────────────────────────────────────────────────────┐
│                 Provider Abstraction                 │
├──────────┬──────────┬──────────┬──────────┬─────────┤
│ Anthropic│ OpenAI   │ Bedrock  │ Vertex   │ Foundry │
│ (Direct) │ (Codex)  │ (AWS)    │ (GCP)    │(Dedicated│
│          │          │          │          │ Deploy) │
├──────────┴──────────┴──────────┴──────────┴─────────┤
│              统一 API 接口层                          │
│         services/api/claude.ts                       │
│                                                      │
│  - 流式响应处理                                      │
│  - 工具调用协议转换                                  │
│  - Token 计数与费用追踪                              │
│  - 错误分类与重试                                    │
└─────────────────────────────────────────────────────┘
```

切换方式：
```bash
# Anthropic (默认)
export ANTHROPIC_API_KEY="sk-..."

# OpenAI Codex
export CLAUDE_CODE_USE_OPENAI=1

# AWS Bedrock
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"

# Google Vertex AI
export CLAUDE_CODE_USE_VERTEX=1

# Anthropic Foundry
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_API_KEY="..."
```

---

## 10. 总结

free-code 是一个复杂但结构清晰的 CLI 应用，其核心设计理念包括：

1. **编译时优化**: 通过 Bun 的 Feature Flag + DCE 实现零运行时开销的可选功能
2. **流式架构**: 基于 AsyncGenerator 的消息流，贯穿从 API 到 UI 的完整链路
3. **模块化注册**: 命令和工具通过注册表模式管理，支持条件加载和权限过滤
4. **终端原生 UI**: 使用 React + Ink 将现代组件模型引入终端
5. **多提供商支持**: 统一抽象层支持五种 API 后端
6. **可扩展性**: 技能、插件、MCP 三层扩展系统

对于想要深入学习或贡献代码的开发者，建议阅读顺序：
1. `src/entrypoints/cli.tsx` — 理解启动流程
2. `src/QueryEngine.ts` — 理解对话生命周期
3. `src/commands.ts` + `src/tools.ts` — 理解注册系统
4. `src/screens/REPL.tsx` — 理解 UI 架构
5. `scripts/build.ts` — 理解构建系统