# codex-persistent-mcp

[English](README.md) | [簡體中文](README.zh-Hans.md) | 繁體中文

一個很薄的 MCP（stdio）Server：把**會話持久化**交給本機 `codex-cli`，使得透過 MCP 呼叫也能產生真實 session，之後使用者可以用 `codex resume <session_id>` 接力繼續聊。

## 解決的問題

- 其他 Agent 透過 MCP 呼叫 Codex，也能產生真實可恢復的 session。
- MCP server 重啟/關閉不丟上下文（上下文存於 Codex CLI 的 session store）。
- 使用者可隨時用 `codex resume <session_id>` 進入同一會話補充資訊/接力對話。

## 依賴

- Node.js（建議 18+）
- `codex-cli`（本專案開發時使用 `codex-cli 0.77.0`）

## 安裝與建置

```bash
npm install
npm run build
```

## 全域安裝（可選）

發佈到 npm 之後，可以全域安裝成 CLI：

```bash
npm install -g codex-persistent-mcp
```

## 執行

```bash
npm start
```

## MCP 工具

本 server 暴露 3 個工具（都會回傳 `session_id` 與 `resume_command`）：

- `codex_chat`
  - 輸入：`session_id?`（UUID）、`prompt`、`model?`、`reasoning_effort?`、`timeout_ms?`
  - 輸出：`session_id`、`reply`、`resume_command`（例如 `codex resume <session_id>`）、`usage?`
- `codex_guard_plan`
  - 輸入：`session_id?`、`requirements`、`plan`、`constraints?`、`model?`、`reasoning_effort?`、`timeout_ms?`
  - 輸出：`session_id`、`critique`、`resume_command`、`usage?`
- `codex_guard_final`
  - 輸入：`session_id?`、`change_summary`、`test_results?`、`open_questions?`、`model?`、`reasoning_effort?`、`timeout_ms?`
  - 輸出：`session_id`、`review`、`resume_command`、`usage?`

## 運作原理（為什麼能 `codex resume`）

每次 tool call 都會 spawn 一個 `codex` 子行程：

- 新會話：
  - `codex exec --skip-git-repo-check --json -C <cwd> "<prompt>"`
- 續寫會話：
  - `codex exec --skip-git-repo-check --json -C <cwd> resume <session_id> "<prompt>"`

然後解析 `--json` 輸出的 JSONL 事件流：

- 讀取 `thread.started.thread_id` 作為 MCP 的 `session_id`
- 收集 `item.completed`（型別為 `agent_message`）並回傳最後一條作為 `reply`

同一個 `session_id` 的並發請求會被序列化，避免對同一會話亂序寫入。

## 環境變數

- `CODEX_BIN`：`codex` 可執行檔路徑（預設 `codex`）
- `CODEX_MCP_CWD`：傳給 `codex -C` 的工作目錄（預設 MCP server 的 `process.cwd()`）
- `CODEX_PERSISTENT_MCP_ORIGIN`：注入到每次請求裡的識別字（預設 `codex-persistent-mcp`）

## 「AI vs 人」標記

Codex CLI 預設並不知道輸入是來自 MCP 的其他 AI 或是使用者本人。

本 server 會在每次請求前自動注入一個 header，讓 Codex 會話可以把訊息標記為「AI agent via MCP（非使用者本人）」。

## 每次呼叫的 model + reasoning 覆蓋

預設情況下，Codex CLI 會讀取 `~/.codex/config.toml`（例如 `model` 與 `model_reasoning_effort`）。

本 MCP 支援對單次呼叫即時覆蓋：

- `model`：透傳為 `codex exec -m <model>`，只對本次請求生效
- `reasoning_effort`：透傳為 `codex exec -c model_reasoning_effort="..."`，只對本次請求生效

不傳上述欄位時，會完全遵循 Codex CLI 的預設配置。

## 在 Claude Code 裡設定這個 MCP

Claude Code 提供 `claude mcp ...` 管理命令。

1) 先 build：

```bash
npm run build
```

2) 新增為 stdio MCP server（建議用絕對路徑）：

```bash
claude mcp add -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- node /absolute/path/to/this/repo/dist/server.js
```

若已全域安裝，也可以這樣寫：

```bash
claude mcp add -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- codex-persistent-mcp
```

若已發佈到 npm，也可以不用 clone 直接用 `npx`：

```bash
claude mcp add -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- npx -y codex-persistent-mcp
```

可選：加 `--scope user` 對所有專案生效：

```bash
claude mcp add --scope user -e CODEX_BIN=/absolute/path/to/codex -e CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- node /absolute/path/to/this/repo/dist/server.js
```

驗證：

```bash
claude mcp list
claude mcp get codex-persistent
```

## 在 Codex CLI 裡設定這個 MCP

Codex CLI 提供 `codex mcp ...` 管理命令。

1) 先 build：

```bash
npm run build
```

2) 新增為 stdio MCP server：

```bash
codex mcp add --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- node /absolute/path/to/this/repo/dist/server.js
```

若已全域安裝：

```bash
codex mcp add --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- codex-persistent-mcp
```

若已發佈到 npm（無需 clone）：

```bash
codex mcp add --env CODEX_BIN=/absolute/path/to/codex --env CODEX_MCP_CWD=/absolute/path/to/your/project codex-persistent -- npx -y codex-persistent-mcp
```

驗證：

```bash
codex mcp list --json
codex mcp get codex-persistent --json
```

## 建議用法（雙 Agent 把關）

- plan 前：把「需求 + 計畫草稿」送給 `codex_guard_plan`，取得漏項/風險/追問/測試建議。
- 收尾前：把「變更摘要 + 測試結果 + 未決問題」送給 `codex_guard_final`，做最終把關。
- 任意時刻：直接 `codex resume <session_id>` 手動接力繼續聊。

## 常見問題

### 找不到 `codex`

常見原因是 PATH 未繼承（例如 nvm）。解法：

- 設定時顯式指定 `CODEX_BIN=/absolute/path/to/codex`（用 `which codex` 找路徑）

### `CODEX_MCP_CWD` 要填什麼？

建議填你的專案根目錄，讓 Codex 看到正確的工作區上下文。

### npm 發佈需要 2FA（維護者）

部分 npm 帳號在發佈套件時會被要求啟用兩步驗證（2FA），或使用可繞過 2FA 的自動化/細粒度 token。

- 啟用寫入 2FA：
  - `npm profile enable-2fa auth-and-writes`
- 然後帶 OTP 發佈：
  - `npm publish --otp=123456`
