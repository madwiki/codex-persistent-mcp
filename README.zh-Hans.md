# codex-persistent-mcp

[English](README.md) | 简体中文 | [繁體中文](README.zh-Hant.md)

一个很薄的 MCP（stdio）Server：把**会话持久化**交给本机 `codex-cli`，使得通过 MCP 调用也能生成真实 session，之后用户可以用 `codex resume <session_id>` 接力继续聊。

## 快速开始（推荐：npx 自动更新）

### Claude Code

```bash
claude mcp add-json --scope user codex-persistent \
  '{"command":"npx","args":["-y","codex-persistent-mcp"],"env":{"CODEX_BIN":"/absolute/path/to/codex","CODEX_MCP_CWD":"/absolute/path/to/your/project"}}'
```

验证：

```bash
claude mcp list
claude mcp get codex-persistent
```

### Codex CLI

```bash
codex mcp add codex-persistent --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project -- npx -y codex-persistent-mcp
```

验证：

```bash
codex mcp list --json
codex mcp get codex-persistent --json
```

### Antigravity

Antigravity 支持用 `--add-mcp` 添加 MCP server：

```bash
antigravity --add-mcp '{"name":"codex-persistent","command":"npx","args":["-y","codex-persistent-mcp"],"env":{"CODEX_BIN":"/absolute/path/to/codex","CODEX_MCP_CWD":"/absolute/path/to/your/project"}}'
```

## 解决的问题

- 其他 Agent 通过 MCP 调用 Codex，也能产生真实可恢复的 session。
- MCP server 重启/关闭不丢上下文（上下文存于 Codex CLI 的 session store）。
- 用户可随时用 `codex resume <session_id>` 进入同一会话补充信息/接力对话。

## 依赖

- Node.js（建议 18+）
- `codex-cli`（本项目开发时使用 `codex-cli 0.77.0`）

## 安装与构建

```bash
npm install
npm run build
```

## 全局安装（可选）

发布到 npm 之后，可以全局安装成 CLI：

```bash
npm install -g codex-persistent-mcp
```

## 运行

```bash
npm start
```

## MCP 工具

本 server 暴露 3 个工具（都会返回 `session_id` 与 `resume_command`）：

- `codex_chat`
  - 输入：`session_id?`（UUID）、`prompt`、`cwd?`、`model?`、`reasoning_effort?`、`timeout_ms?`
  - 输出：`session_id`、`reply`、`resume_command`（例如 `codex resume <session_id>`）、`usage?`
- `codex_guard_plan`
  - 输入：`session_id?`、`requirements`、`plan`、`constraints?`、`cwd?`、`model?`、`reasoning_effort?`、`timeout_ms?`
  - 输出：`session_id`、`critique`、`resume_command`、`usage?`
- `codex_guard_final`
  - 输入：`session_id?`、`change_summary`、`test_results?`、`open_questions?`、`cwd?`、`model?`、`reasoning_effort?`、`timeout_ms?`
  - 输出：`session_id`、`review`、`resume_command`、`usage?`

## 工作原理（为什么能 `codex resume`）

每次 tool call 都会 spawn 一个 `codex` 子进程：

- 新会话：
  - `codex exec --skip-git-repo-check --json -C <cwd> "<prompt>"`
- 续写会话：
  - `codex exec --skip-git-repo-check --json -C <cwd> resume <session_id> "<prompt>"`

然后解析 `--json` 输出的 JSONL 事件流：

- 读取 `thread.started.thread_id` 作为 MCP 的 `session_id`
- 收集 `item.completed`（类型为 `agent_message`）并返回最后一条作为 `reply`

同一个 `session_id` 的并发请求会被串行化，避免对同一会话乱序写入。

## 环境变量

- `CODEX_BIN`：`codex` 可执行文件路径（默认 `codex`）
- `CODEX_MCP_CWD`：传给 `codex -C` 的工作目录（默认 MCP server 的 `process.cwd()`）
- `CODEX_PERSISTENT_MCP_ORIGIN`：注入到每次请求里的标识（默认 `codex-persistent-mcp`）

如果 tool 输入里传了 `cwd`，该请求会优先使用它（覆盖 `CODEX_MCP_CWD`）。

## “AI vs 人” 标记

Codex CLI 默认并不知道输入是来自 MCP 的其他 AI 还是用户本人。

本 server 会在每次请求前自动注入一个 header，让 Codex 会话可以将消息标记为 “AI agent via MCP（非用户本人）”。

## 每次调用的 model + reasoning 覆盖

默认情况下，Codex CLI 会读取 `~/.codex/config.toml`（例如 `model` 与 `model_reasoning_effort`）。

本 MCP 支持对单次调用即时覆盖：

- `model`：透传为 `codex exec -m <model>`，只对本次请求生效
- `reasoning_effort`：透传为 `codex exec -c model_reasoning_effort="..."`，只对本次请求生效

不传上述字段时，会完全遵循 Codex CLI 的默认配置。

## 在 Claude Code 里配置这个 MCP

Claude Code 提供 `claude mcp ...` 管理命令。

推荐用 `add-json` 配置（可以同时设置 env，并用 `npx -y` 方式启动）：

```bash
claude mcp add-json --scope user codex-persistent \
  '{"command":"npx","args":["-y","codex-persistent-mcp"],"env":{"CODEX_BIN":"/absolute/path/to/codex","CODEX_MCP_CWD":"/absolute/path/to/your/project"}}'
```

如果你想固定版本（可复现）：

```bash
claude mcp add-json --scope user codex-persistent \
  '{"command":"npx","args":["-y","codex-persistent-mcp@0.1.2"],"env":{"CODEX_BIN":"/absolute/path/to/codex","CODEX_MCP_CWD":"/absolute/path/to/your/project"}}'
```

验证：

```bash
claude mcp list
claude mcp get codex-persistent
```

## 在 Codex CLI 里配置这个 MCP

Codex CLI 提供 `codex mcp ...` 管理命令。

1) 先 build：

```bash
npm run build
```

2) 添加为 stdio MCP server：

```bash
codex mcp add --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- node /absolute/path/to/this/repo/dist/server.js
```

如果已全局安装：

```bash
codex mcp add --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- codex-persistent-mcp
```

如果已发布到 npm（无需 clone）：

```bash
codex mcp add --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- npx -y codex-persistent-mcp
```

验证：

```bash
codex mcp list --json
codex mcp get codex-persistent --json
```

## 版本固定与自动更新

`npx -y codex-persistent-mcp` 一般会拉取最新版本，方便但可复现性更差。

如果要固定版本：

```bash
npx -y codex-persistent-mcp@0.1.3
```

## 推荐用法（双 Agent 把关）

- plan 前：把“需求 + 计划草稿”发给 `codex_guard_plan`，获取漏项/风险/追问/测试建议。
- 收尾前：把“变更摘要 + 测试结果 + 未决问题”发给 `codex_guard_final`，做最终把关。
- 任意时刻：直接 `codex resume <session_id>` 手动接力继续聊。

## 常见问题

### 找不到 `codex`

常见原因是 PATH 未继承（例如 nvm）。解决：

- 配置时显式设置 `CODEX_BIN=/absolute/path/to/codex`（用 `which codex` 找路径）

### `CODEX_MCP_CWD` 填什么？

建议填你的项目根目录，让 Codex 看到正确的工作区上下文。

### npm 发布需要 2FA（维护者）

部分 npm 账号在发布包时会被要求开启两步验证（2FA），或使用可绕过 2FA 的自动化/细粒度 token。

- 开启写入 2FA：
  - `npm profile enable-2fa auth-and-writes`
- 然后带 OTP 发布：
  - `npm publish --otp=123456`
