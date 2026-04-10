# GLM 模型接入 free-code 使用说明

## 终端选择

free-code 使用 Ink (React 终端 UI) 渲染界面，包含较多 Unicode 字符，例如进度动画、边框和状态图标。

在 Windows 上，传统的 `cmd.exe` / 旧版 `powershell.exe` 控制台经常会出现这些问题：

- 窗口尺寸很小
- 字体很小
- Unicode 字符显示错乱或看起来像乱码

推荐使用以下终端运行：

1. VS Code 内置终端
2. Windows Terminal
3. 其他支持完整 Unicode 渲染的现代终端

`start-free-code.bat` 现在会优先在当前现代终端中运行；如果你是从资源管理器双击启动，并且系统安装了 Windows Terminal，它会自动切换到 Windows Terminal，再启动 free-code。

推荐的 Windows 用法是：

- 在 Windows Terminal 中直接运行 `start-free-code.bat`
- 或者给 `start-free-code.bat` 建一个桌面快捷方式，双击后由 Windows Terminal 打开

不推荐直接运行 `cli.exe` 或在旧版控制台里双击启动，因为那样仍然可能回到小窗口、小字号和不完整的 Unicode 渲染环境。

## 安全配置

不要把真实的 GLM Key 写进脚本、README 或仓库文件。

仓库现在支持两种安全配置方式：

1. 在当前终端里直接设置环境变量
2. 在仓库根目录创建本地 `.env.glm` 文件（已加入 `.gitignore`）

可以直接复制样例文件：

```bash
cp .env.glm.example .env.glm
```

然后填入你自己的 `GLM_API_KEY`。

支持的配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GLM_API_KEY` | 智谱 API Key | 必填 |
| `GLM_MODEL` | 使用的模型 | `glm-5.1` |
| `GLM_PROXY_PORT` | 本地代理端口 | `3827` |
| `GLM_API_BASE` | 智谱接口基础地址 | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `GLM_MAX_TOKENS` | 最大输出 token 数 | `131072` |
| `GLM_TEMPERATURE` | 温度参数 | `0.2` |
| `FREE_CODE_DEFAULT_DIR` | 默认工作目录，未传目录参数时生效 | 脚本所在目录 |

## 快速开始

### 方法一：推荐，直接在现代终端中启动

Windows PowerShell / Windows Terminal:

```powershell
$env:GLM_API_KEY="your_glm_api_key"
.\start-free-code.bat
```

指定项目目录启动：

```powershell
.\start-free-code.bat "G:\Study\another-project"
```

Linux / macOS:

```bash
export GLM_API_KEY="your_glm_api_key"
./start-free-code.sh
```

指定项目目录启动：

```bash
./start-free-code.sh /path/to/another-project
```

### 方法二：使用本地 `.env.glm`

在仓库根目录创建 `.env.glm`：

```dotenv
GLM_API_KEY=your_glm_api_key
GLM_MODEL=glm-5.1
GLM_PROXY_PORT=3827
FREE_CODE_DEFAULT_DIR=G:\Study\another-project
```

然后启动：

Windows:

```cmd
start-free-code.bat
```

Linux / macOS:

```bash
./start-free-code.sh
```

## 运行方式说明

`start-free-code.bat` / `start-free-code.sh` 会做这些事情：

1. 读取当前环境变量和可选的本地 `.env.glm`
2. 检查 `GLM_API_KEY` 是否存在，缺失时直接失败
3. 检查本地代理是否已在运行，已运行就复用
4. 如未运行则启动 `glm-proxy.mjs`
5. 如果第一个参数是目录，则把它作为 free-code 的工作目录
6. 在当前终端中启动 free-code，而不是强制新开旧版 PowerShell 窗口
7. free-code 退出后不会自动关闭代理，方便多个项目窗口共享同一个 GLM 代理

这样可以尽量避免 Windows 上的小窗口、小字体和乱码问题。

工作目录优先级如下：

1. 启动命令传入的目录参数
2. `.env.glm` 或环境变量中的 `FREE_CODE_DEFAULT_DIR`
3. `start-free-code` 脚本所在目录

如果 `FREE_CODE_DEFAULT_DIR` 配置了一个不存在的目录，脚本会给出警告，并自动回退到脚本所在目录。

## 多开 free-code

当前推荐并验证的使用方式是：

- 不同项目可以同时开多个 free-code 窗口
- 这些窗口共享同一个本地 GLM 代理
- 关闭其中一个 free-code 窗口，不会自动停止代理

示例：

```powershell
.\start-free-code.bat "G:\Study\project-a"
.\start-free-code.bat "G:\Study\project-b"
```

```bash
./start-free-code.sh /path/to/project-a
./start-free-code.sh /path/to/project-b
```

如果你暂时不用了代理，可以手动运行 `stop-glm-proxy.bat` 停止它。

说明：

- 本次方案的目标是“不同项目多开”
- 同一项目下也可以再开多个 interactive 会话，但它们会共享项目级上下文和会话存储，这不是本次重点优化范围

## 跳过认证登录

free-code 本身已经支持通过 `ANTHROPIC_API_KEY` 进入 API Key 模式。

这套接入方式没有修改 free-code 的核心认证逻辑，而是通过启动脚本设置：

```text
ANTHROPIC_API_KEY=<your_glm_api_key>
ANTHROPIC_BASE_URL=http://localhost:3827
```

这样 free-code 会直接走 API Key 模式，并把请求发到本地 `glm-proxy`。

## 工作原理

```text
free-code -> Anthropic SDK -> localhost:3827 (glm-proxy) -> open.bigmodel.cn API
```

代理会把 Anthropic Messages API 转换成 OpenAI Chat Completions 请求，再把返回结果重新转换回 Anthropic 兼容格式。

当前版本包含：

- 非流式消息转换
- 流式文本输出转换
- 流式 `tool_calls` -> Anthropic `tool_use` 事件转换
- 更安全的 usage 处理，不再用 chunk 数冒充 token 数

## 单独启动代理

如果你只想单独启动代理：

Windows PowerShell:

```powershell
$env:GLM_API_KEY="your_glm_api_key"
node .\glm-proxy.mjs
```

Linux / macOS:

```bash
export GLM_API_KEY="your_glm_api_key"
node ./glm-proxy.mjs
```

如果仓库根目录存在 `.env.glm`，`glm-proxy.mjs` 也会自动读取它。

如果你已经提前单独启动了代理，之后再运行 `start-free-code.bat` / `start-free-code.sh` 时会自动复用，不会重复起新代理。

## 文件说明

| 文件 | 说明 |
|------|------|
| `glm-proxy.mjs` | Node.js 版本的 GLM 代理 |
| `glm-proxy.ts` | Bun/TypeScript 版本的 GLM 代理 |
| `start-free-code.bat` | Windows 启动脚本 |
| `start-free-code.sh` | Linux/macOS 启动脚本 |
| `.env.glm.example` | 本地配置样例文件 |

## 排查建议

如果 Windows 上仍然显示异常，优先检查：

1. 是否是在 VS Code 终端或 Windows Terminal 里运行
2. 是否仍然在使用旧的传统控制台窗口
3. 是否系统没有安装 Windows Terminal，导致双击 `.bat` 时只能落回旧控制台

如果代理启动失败，优先检查：

1. `GLM_API_KEY` 是否已设置
2. `node` 和 `bun` 是否在 `PATH` 中
3. `GLM_PROXY_PORT` 是否被其他进程占用
