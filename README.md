# codex-persistent-mcp

English | [Chinese (Simplified)](README.zh-Hans.md) | [Chinese (Traditional)](README.zh-Hant.md)

A thin MCP (stdio) server that delegates **session persistence** to your local `codex-cli`, so MCP calls also create real sessions that users can later continue with `codex resume <session_id>`.

## Quick start (recommended: npx auto-update)

### Claude Code

```bash
claude mcp add-json --scope user codex-persistent \
  '{"command":"npx","args":["-y","codex-persistent-mcp"],"env":{"CODEX_BIN":"/absolute/path/to/codex"}}'
```

Verify:

```bash
claude mcp list
claude mcp get codex-persistent
```

### Codex CLI

```bash
codex mcp add codex-persistent --env CODEX_BIN=/absolute/path/to/codex -- npx -y codex-persistent-mcp
```

Verify:

```bash
codex mcp list --json
codex mcp get codex-persistent --json
```

### Antigravity

Antigravity supports adding MCP servers via `--add-mcp`:

```bash
antigravity --add-mcp '{"name":"codex-persistent","command":"npx","args":["-y","codex-persistent-mcp"],"env":{"CODEX_BIN":"/absolute/path/to/codex"}}'
```

## What this solves

- Other agents can call Codex via MCP and still get a real persisted session.
- Server restarts do not lose context (the context lives in Codex CLI’s session store).
- Users can resume at any time with `codex resume <session_id>` to continue the same conversation.

## Requirements

- Node.js (recommended: 18+)
- `codex-cli` (developed against `codex-cli 0.77.0`)

## Install & build

```bash
npm install
npm run build
```

## Install globally (optional)

After publishing to npm, you can install it as a global CLI:

```bash
npm install -g codex-persistent-mcp
```

## Run

```bash
npm start
```

## Tools

This server exposes 3 tools (all return `session_id` and `resume_command`):

- `codex_chat`
  - input: `session_id?` (UUID), `prompt`, `cwd?`, `model?`, `reasoning_effort?`, `timeout_ms?`
  - output: `session_id`, `reply`, `resume_command` (e.g. `codex resume <session_id>`), `usage?`
- `codex_guard_plan`
  - input: `session_id?`, `requirements`, `plan`, `constraints?`, `cwd?`, `model?`, `reasoning_effort?`, `timeout_ms?`
  - output: `session_id`, `critique`, `resume_command`, `usage?`
- `codex_guard_final`
  - input: `session_id?`, `change_summary`, `test_results?`, `open_questions?`, `cwd?`, `model?`, `reasoning_effort?`, `timeout_ms?`
  - output: `session_id`, `review`, `resume_command`, `usage?`

## How it works (why `codex resume` works)

Each tool call spawns a `codex` subprocess:

- new session:
  - `codex exec --skip-git-repo-check --json -C <cwd> "<prompt>"`
- resume session:
  - `codex exec --skip-git-repo-check --json -C <cwd> resume <session_id> "<prompt>"`

The server parses the JSONL event stream produced by `--json`:

- Reads `thread.started.thread_id` as the MCP `session_id`
- Collects `item.completed` events of type `agent_message` and returns the final message as `reply`

Requests for the same `session_id` are serialized to avoid out-of-order writes.

## Environment variables

- `CODEX_BIN`: path to the `codex` executable (default: `codex`)
- `CODEX_PERSISTENT_MCP_ORIGIN`: identifier injected into every prompt (default: `codex-persistent-mcp`)
 
## Working directory (`cwd`)

Codex stores session metadata including the workspace CWD, and `codex resume` filters sessions by CWD by default.

- When starting a new session (no `session_id`), you must pass `cwd` (repo root).
- When resuming (with `session_id`), `cwd` is optional: the server will reuse or infer it from Codex’s local session store.

## “AI vs human” attribution

Codex CLI does not automatically know that an input came from another AI via MCP.

This server always injects a small header into every request so the Codex session can attribute messages as coming from an AI agent over MCP (not a human user).

## Per-request model + reasoning overrides

By default, Codex CLI reads your `~/.codex/config.toml` (e.g. `model` and `model_reasoning_effort`).

This MCP server supports per-request overrides:

- `model`: passed to `codex exec -m <model>` for that request only
- `reasoning_effort`: passed as `codex exec -c model_reasoning_effort="..."` for that request only

If you do not pass these fields, the request follows Codex CLI defaults.

## Version pinning vs auto-update

`npx -y codex-persistent-mcp` generally pulls the latest version, which is convenient but less reproducible.

To pin a version:

```bash
npx -y codex-persistent-mcp@0.1.3
```

## Suggested workflow (two-agent guardrail)

- Before planning: send “requirements + draft plan” to `codex_guard_plan` to get gaps/risks/questions/tests.
- Before finishing: send “change summary + test results + open questions” to `codex_guard_final` for a final review.
- At any time: use `codex resume <session_id>` to continue the same session manually.

## Troubleshooting

### `codex` not found

Common when PATH is not inherited (e.g. nvm). Fix by setting:

- `CODEX_BIN=/absolute/path/to/codex` (use `which codex` to find it)

### Why pass `cwd`?

Pass your project root so Codex records the correct workspace context and `codex resume` shows the session in that repo by default.

### npm publish requires 2FA (maintainers)

Some npm accounts are required to use two-factor authentication (2FA) or an automation/granular token that can bypass 2FA when publishing.

- Enable 2FA for writes:
  - `npm profile enable-2fa auth-and-writes`
- Then publish with a one-time password (OTP):
  - `npm publish --otp=123456`
