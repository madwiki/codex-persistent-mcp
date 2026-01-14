# codex-persistent-mcp

[English](README.md) | 简体中文 | [繁體中文](README.zh-Hant.md)

一个很薄的 MCP（stdio）Server：把**会话持久化**交给本机 `codex-cli`，使得通过 MCP 调用也能生成真实 session，之后用户可以用 `codex resume <session_id>` 接力继续聊。

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
  - 输入：`session_id?`（UUID）、`prompt`、`model?`、`timeout_ms?`
  - 输出：`session_id`、`reply`、`resume_command`（例如 `codex resume <session_id>`）、`usage?`
- `codex_guard_plan`
  - 输入：`session_id?`、`requirements`、`plan`、`constraints?`、`model?`、`timeout_ms?`
  - 输出：`session_id`、`critique`、`resume_command`、`usage?`
- `codex_guard_final`
  - 输入：`session_id?`、`change_summary`、`test_results?`、`open_questions?`、`model?`、`timeout_ms?`
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

## 在 Claude Code 里配置这个 MCP

Claude Code 提供 `claude mcp ...` 管理命令。

1) 先 build：

```bash
npm run build
```

2) 添加为 stdio MCP server（建议用绝对路径）：

```bash
claude mcp add -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- node /absolute/path/to/this/repo/dist/server.js
```

如果已全局安装，也可以这样写：

```bash
claude mcp add -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- codex-persistent-mcp
```

如果已发布到 npm，也可以不 clone 仓库直接用 `npx`：

```bash
claude mcp add -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- npx -y codex-persistent-mcp
```

可选：加 `--scope user` 对所有项目生效：

```bash
claude mcp add --scope user -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- node /absolute/path/to/this/repo/dist/server.js
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
