#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const SERVER_CWD = process.cwd();
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const DEFAULT_TIMEOUT_MS = 120_000;
const MCP_ORIGIN = process.env.CODEX_PERSISTENT_MCP_ORIGIN ?? 'codex-persistent-mcp';
const ROLE_CARD_ENABLED = (process.env.CODEX_PERSISTENT_MCP_ROLE_CARD ?? '1') !== '0';
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const CODEX_HISTORY_PATH =
  process.env.CODEX_PERSISTENT_MCP_CODEX_HISTORY_PATH ??
  join(CODEX_HOME, 'history.jsonl');
const REGISTER_IN_CODEX_HISTORY =
  (process.env.CODEX_PERSISTENT_MCP_REGISTER_IN_CODEX_HISTORY ?? '1') !== '0';

type CodexArgsInput = {
  sessionId?: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
};

const roleCardSent = new Set<string>();
const historyRecorded = new Set<string>();
const sessionCwd = new Map<string, string>();
const sessionPromoted = new Set<string>();

function roleCardText(): string {
  return [
    '<<<ROLE_CARD_BEGIN>>>',
    'This session may include messages from a human user (via `codex resume`) and from an AI agent (via MCP).',
    'If the message includes an `<<<MCP_CONTEXT_BEGIN>>>` block, you are advising the calling AI agent (not the end user).',
    'If you need user input, list the minimum questions for the agent to ask the user (do not ask the user directly).',
    'If the message has no MCP context block, treat it as coming from the human user.',
    'Keep responses concise and practical; avoid endless critique loops.',
    '<<<ROLE_CARD_END>>>'
  ].join('\n');
}

type RepoSessionFile = {
  session_id?: unknown;
  updated_at?: unknown;
  summary?: unknown;
};

function tryReadRepoSessionId(cwd: string): string | undefined {
  try {
    const path = join(cwd, '.claude', 'codex_session.json');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as RepoSessionFile;
    const sessionId = parsed?.session_id;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function tryWriteRepoSessionId(cwd: string, sessionId: string): void {
  try {
    const dir = join(cwd, '.claude');
    const path = join(dir, 'codex_session.json');
    mkdirSync(dir, { recursive: true });

    let existing: Record<string, unknown> | undefined;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing/invalid file is fine.
    }

    const next = {
      ...(existing ?? {}),
      session_id: sessionId,
      updated_at: new Date().toISOString()
    };

    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, path);
  } catch {
    // Best-effort only: avoid breaking MCP responses due to local file writes.
  }
}

function historyLabel(toolName: string, prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const prefix =
    toolName === 'codex_chat'
      ? 'MCP chat'
      : toolName === 'codex_plan' || toolName === 'codex_guard_plan'
        ? 'MCP plan'
        : toolName === 'codex_review' || toolName === 'codex_guard_final'
          ? 'MCP review'
          : `MCP ${toolName}`;
  const excerpt = normalized.slice(0, 140);
  return excerpt ? `${prefix}: ${excerpt}` : prefix;
}

function tryRegisterInCodexHistory(sessionId: string, text: string): void {
  if (!REGISTER_IN_CODEX_HISTORY) return;
  if (historyRecorded.has(sessionId)) return;

  try {
    const historyDir = dirname(CODEX_HISTORY_PATH);
    mkdirSync(historyDir, { recursive: true });

    try {
      const size = statSync(CODEX_HISTORY_PATH).size;
      if (size <= 5_000_000) {
        const existing = readFileSync(CODEX_HISTORY_PATH, 'utf8');
        if (existing.includes(sessionId)) {
          historyRecorded.add(sessionId);
          return;
        }
      }
    } catch {
      // Missing file is fine.
    }

    const entry = {
      session_id: sessionId,
      ts: Math.floor(Date.now() / 1000),
      text
    };
    appendFileSync(CODEX_HISTORY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    historyRecorded.add(sessionId);
  } catch {
    // Best-effort only: avoid breaking MCP responses due to local history indexing.
  }
}

type RolloutSessionMeta = {
  cwd?: string;
  originator?: string;
  source?: string;
};

function tryReadSessionMetaFromRollout(filePath: string): RolloutSessionMeta | undefined {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const firstNewline = raw.indexOf('\n');
    const firstLine = (firstNewline === -1 ? raw : raw.slice(0, firstNewline)).trim();
    if (!firstLine) return undefined;
    const event = JSON.parse(firstLine);
    if (event?.type !== 'session_meta') return undefined;
    const cwd = event?.payload?.cwd;
    const originator = event?.payload?.originator;
    const source = event?.payload?.source;
    return {
      cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined,
      originator: typeof originator === 'string' && originator.length > 0 ? originator : undefined,
      source: typeof source === 'string' && source.length > 0 ? source : undefined
    };
  } catch {
    return undefined;
  }
}

function tryFindRolloutPathForSession(sessionId: string): string | undefined {
  try {
    const sessionsRoot = join(CODEX_HOME, 'sessions');
    const years = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());

    let bestPath: string | undefined;
    let bestMtime = -1;

    for (const year of years) {
      const yearPath = join(sessionsRoot, year.name);
      const months = readdirSync(yearPath, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const month of months) {
        const monthPath = join(yearPath, month.name);
        const days = readdirSync(monthPath, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const day of days) {
          const dayPath = join(monthPath, day.name);
          const files = readdirSync(dayPath, { withFileTypes: true }).filter((d) => d.isFile());
          for (const file of files) {
            if (!file.name.endsWith('.jsonl')) continue;
            if (!file.name.includes(sessionId)) continue;
            const fullPath = join(dayPath, file.name);
            let mtime = 0;
            try {
              mtime = statSync(fullPath).mtimeMs;
            } catch {
              mtime = 0;
            }
            if (mtime > bestMtime) {
              bestMtime = mtime;
              bestPath = fullPath;
            }
          }
        }
      }
    }

    return bestPath;
  } catch {
    return undefined;
  }
}

function tryInferCwdForSession(sessionId: string): string | undefined {
  const cached = sessionCwd.get(sessionId);
  if (cached) return cached;

  const rolloutPath = tryFindRolloutPathForSession(sessionId);
  if (!rolloutPath) return undefined;

  const meta = tryReadSessionMetaFromRollout(rolloutPath);
  if (!meta?.cwd) return undefined;

  sessionCwd.set(sessionId, meta.cwd);
  return meta.cwd;
}

function resolveCwdForCall(sessionId: string | undefined, cwd: string | undefined): string {
  if (!sessionId) {
    if (!cwd) {
      throw new Error('Missing required input: `cwd` is required when starting a new session.');
    }
    return cwd;
  }

  const known = tryInferCwdForSession(sessionId);
  if (known) return known;

  if (cwd) {
    sessionCwd.set(sessionId, cwd);
    return cwd;
  }

  throw new Error(
    'Missing required input: `cwd` could not be inferred for this `session_id`. Pass `cwd` once (repo root) to bind it.'
  );
}

function tryPromoteExecSessionToCli(sessionId: string): void {
  if (sessionPromoted.has(sessionId)) return;
  sessionPromoted.add(sessionId);

  const rolloutPath = tryFindRolloutPathForSession(sessionId);
  if (!rolloutPath) return;

  try {
    const raw = readFileSync(rolloutPath, 'utf8');
    const firstNewline = raw.indexOf('\n');
    if (firstNewline === -1) return;

    const firstLine = raw.slice(0, firstNewline).trimEnd();
    const rest = raw.slice(firstNewline + 1);

    const event = JSON.parse(firstLine);
    if (event?.type !== 'session_meta') return;
    if (event?.payload?.id !== sessionId) return;
    if (event?.payload?.originator !== 'codex_exec') return;
    if (event?.payload?.source !== 'exec') return;

    const updated = {
      ...event,
      payload: {
        ...event.payload,
        originator: 'codex_cli_rs',
        source: 'cli'
      }
    };

    const newFirstLine = JSON.stringify(updated);
    if (newFirstLine.includes('\n')) return;

    const tmpPath = `${rolloutPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, `${newFirstLine}\n${rest}`, 'utf8');
    renameSync(tmpPath, rolloutPath);
  } catch {
    // Best-effort only: avoid breaking MCP responses due to local file writes.
  }
}

function toolResponsibility(toolName: string): string {
  switch (toolName) {
    case 'codex_chat':
      return 'You are advising the calling AI agent (not the end user). If you need user input, list the minimum questions for the agent to ask the user (do not ask the user directly). If you disagree or suspect a misunderstanding, state it and name the differing assumption.';
    case 'codex_plan':
    case 'codex_guard_plan':
      return 'Review a proposed plan for missing requirements, risks, unclear questions, and suggested tests. If you suspect misunderstanding, call it out and propose the minimum clarifying questions for the agent to ask the user.';
    case 'codex_review':
    case 'codex_guard_final':
      return 'Review final change summary for correctness, regressions, missing coverage, and rollback concerns. Distinguish blockers vs suggestions and keep feedback concise. If you need user input, list the minimum questions for the agent to ask the user.';
    default:
      return 'Handle the request appropriately.';
  }
}

function injectMcpHeader(toolName: string, userText: string, includeRoleCard: boolean): string {
  const headerLines = [
    '<<<MCP_CONTEXT_BEGIN>>>',
    `origin=${MCP_ORIGIN}`,
    `tool=${toolName}`,
    'audience=ai_agent',
    `responsibility=${toolResponsibility(toolName)}`,
    'sender=ai_agent',
    '<<<MCP_CONTEXT_END>>>'
  ];
  const prefix = headerLines.join('\n');
  if (!includeRoleCard) return `${prefix}\n\n${userText}`;
  return `${prefix}\n\n${roleCardText()}\n\n${userText}`;
}

function tomlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildCodexArgs({ sessionId, cwd, prompt, model, reasoningEffort }: CodexArgsInput): string[] {
  const base = [
    'exec',
    '--skip-git-repo-check',
    '--json',
    '-C',
    cwd
  ];

  if (model) base.push('-m', model);
  if (reasoningEffort) base.push('-c', `model_reasoning_effort=${tomlString(reasoningEffort)}`);

  if (sessionId) return [...base, 'resume', sessionId, prompt];
  return [...base, prompt];
}

type CodexRunInput = {
  sessionId?: string;
  toolName: string;
  cwd?: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
};

type CodexRunResult = {
  sessionId: string;
  reply: string;
  usage?: unknown;
};

async function runCodexOnce({
  sessionId,
  toolName,
  cwd,
  prompt,
  model,
  reasoningEffort,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: CodexRunInput): Promise<CodexRunResult> {
  const includeRoleCard =
    ROLE_CARD_ENABLED && (!sessionId || !roleCardSent.has(sessionId));
  if (includeRoleCard && sessionId) roleCardSent.add(sessionId);

  const effectiveCwd = resolveCwdForCall(sessionId, cwd);
  const effectivePrompt = injectMcpHeader(toolName, prompt, includeRoleCard);
  const args = buildCodexArgs({
    sessionId,
    cwd: effectiveCwd,
    prompt: effectivePrompt,
    model,
    reasoningEffort
  });

  const child = spawn(CODEX_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';

  let threadId: string | undefined;
  const agentMessages: string[] = [];
  let usage: unknown | undefined;

  const parseEvent = (event: any) => {
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
    }
    if (
      event?.type === 'item.completed' &&
      event?.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      agentMessages.push(event.item.text);
    }
    if (event?.type === 'turn.completed' && event.usage) {
      usage = event.usage;
    }
  };

  const parseChunk = (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      parseEvent(event);
    }
  };

  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

  child.stdout.on('data', parseChunk);
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString('utf8');
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  }).finally(() => clearTimeout(timeout));

  if (exitCode !== 0) {
    const details = stderrBuffer.trim() || `codex exited with code ${exitCode}`;
    throw new Error(details);
  }

  // Best-effort parse of any trailing non-newline JSONL.
  const trailing = stdoutBuffer.trim();
  if (trailing) {
    try {
      parseEvent(JSON.parse(trailing));
    } catch {
      // Ignore trailing parse errors.
    }
  }

  if (!threadId) throw new Error('Failed to detect Codex thread_id from JSONL output.');
  if (agentMessages.length === 0) throw new Error('No agent_message received from Codex.');

  if (includeRoleCard) roleCardSent.add(threadId);
  sessionCwd.set(threadId, effectiveCwd);
  tryRegisterInCodexHistory(threadId, historyLabel(toolName, prompt));
  tryPromoteExecSessionToCli(threadId);
  tryWriteRepoSessionId(effectiveCwd, threadId);

  return {
    sessionId: threadId,
    reply: agentMessages[agentMessages.length - 1],
    usage
  };
}

const sessionQueue = new Map<string, Promise<unknown>>();

function enqueueBySession<T>(sessionId: string | undefined, task: () => Promise<T>): Promise<T> {
  if (!sessionId) return task();
  const prior = sessionQueue.get(sessionId) ?? Promise.resolve();
  const next = prior.then(task, task);
  sessionQueue.set(
    sessionId,
    next.finally(() => {
      if (sessionQueue.get(sessionId) === next) sessionQueue.delete(sessionId);
    })
  );
  return next as Promise<T>;
}

const server = new McpServer({
  name: 'codex-persistent-mcp',
  version: (() => {
    try {
      const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    } catch {
      return '0.0.0';
    }
  })()
});

server.registerTool(
  'codex_chat',
  {
    description:
      'Chat with Codex CLI using a real persisted session that can be resumed via `codex resume <session_id>`.',
    inputSchema: {
      session_id: z.string().uuid().optional().describe('Existing Codex session id (UUID).'),
      prompt: z.string().min(1).describe('User message to send to Codex.'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe('Working root passed to Codex (-C). Required for new sessions; optional when resuming via session_id.'),
      model: z.string().optional().describe('Optional Codex model override.'),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe('Optional per-request override for model_reasoning_effort (e.g. low, medium, high).'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      reply: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({ session_id, prompt, cwd, model, reasoning_effort, timeout_ms }) => {
    const effectiveSessionId = session_id ?? (cwd ? tryReadRepoSessionId(cwd) : undefined);
    const result = await enqueueBySession(effectiveSessionId, () =>
      runCodexOnce({
        sessionId: effectiveSessionId,
        toolName: 'codex_chat',
        cwd,
        prompt,
        model,
        reasoningEffort: reasoning_effort,
        timeoutMs: timeout_ms
      })
    );
    const structuredContent = {
      session_id: result.sessionId,
      reply: result.reply,
      resume_command: `codex resume ${result.sessionId}`,
      usage: result.usage
    };
    return {
      content: [{ type: 'text', text: result.reply }],
      structuredContent
    };
  }
);

server.registerTool(
  'codex_guard_plan',
  {
    description: 'Ask Codex to critique a proposed plan (missing items, risks, questions, tests).',
    inputSchema: {
      session_id: z.string().uuid().optional().describe('Optional Codex session id (UUID).'),
      requirements: z.string().min(1).describe('User requirements / acceptance criteria.'),
      plan: z.string().min(1).describe('Proposed plan to critique.'),
      constraints: z.string().optional().describe('Optional constraints (tech, time, safety).'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe('Working root passed to Codex (-C). Required for new sessions; optional when resuming via session_id.'),
      model: z.string().optional().describe('Optional Codex model override.'),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe('Optional per-request override for model_reasoning_effort (e.g. low, medium, high).'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      critique: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({ session_id, requirements, plan, constraints, cwd, model, reasoning_effort, timeout_ms }) => {
    const effectiveSessionId = session_id ?? (cwd ? tryReadRepoSessionId(cwd) : undefined);
    const prompt = [
      'Reply in Chinese.',
      '## Requirements',
      requirements.trim(),
      '',
      constraints ? `## Constraints\n${constraints.trim()}\n` : '',
      '## Proposed plan',
      plan.trim()
    ]
      .filter(Boolean)
      .join('\n');

    const result = await enqueueBySession(effectiveSessionId, () =>
      runCodexOnce({
        sessionId: effectiveSessionId,
        toolName: 'codex_guard_plan',
        cwd,
        prompt,
        model,
        reasoningEffort: reasoning_effort,
        timeoutMs: timeout_ms
      })
    );

    const structuredContent = {
      session_id: result.sessionId,
      critique: result.reply,
      resume_command: `codex resume ${result.sessionId}`,
      usage: result.usage
    };

    return {
      content: [{ type: 'text', text: result.reply }],
      structuredContent
    };
  }
);

server.registerTool(
  'codex_plan',
  {
    description: 'Ask Codex to review a proposed plan (missing items, risks, questions, tests).',
    inputSchema: {
      session_id: z.string().uuid().optional().describe('Optional Codex session id (UUID).'),
      requirements: z.string().min(1).describe('User requirements / acceptance criteria.'),
      plan: z.string().min(1).describe('Proposed plan to review.'),
      constraints: z.string().optional().describe('Optional constraints (tech, time, safety).'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe('Working root passed to Codex (-C). Required for new sessions; optional when resuming via session_id.'),
      model: z.string().optional().describe('Optional Codex model override.'),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe('Optional per-request override for model_reasoning_effort (e.g. low, medium, high).'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      critique: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({ session_id, requirements, plan, constraints, cwd, model, reasoning_effort, timeout_ms }) => {
    const effectiveSessionId = session_id ?? (cwd ? tryReadRepoSessionId(cwd) : undefined);
    const prompt = [
      'Reply in Chinese.',
      '## Requirements',
      requirements.trim(),
      '',
      constraints ? `## Constraints\n${constraints.trim()}\n` : '',
      '## Proposed plan',
      plan.trim()
    ]
      .filter(Boolean)
      .join('\n');

    const result = await enqueueBySession(effectiveSessionId, () =>
      runCodexOnce({
        sessionId: effectiveSessionId,
        toolName: 'codex_plan',
        cwd,
        prompt,
        model,
        reasoningEffort: reasoning_effort,
        timeoutMs: timeout_ms
      })
    );

    const structuredContent = {
      session_id: result.sessionId,
      critique: result.reply,
      resume_command: `codex resume ${result.sessionId}`,
      usage: result.usage
    };

    return {
      content: [{ type: 'text', text: result.reply }],
      structuredContent
    };
  }
);

server.registerTool(
  'codex_guard_final',
  {
    description: 'Ask Codex to review final changes (correctness, regressions, missing coverage).',
    inputSchema: {
      session_id: z.string().uuid().optional().describe('Optional Codex session id (UUID).'),
      change_summary: z.string().min(1).describe('What changed and why.'),
      test_results: z.string().optional().describe('Test results or commands run.'),
      open_questions: z.string().optional().describe('Anything uncertain that needs a decision.'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe('Working root passed to Codex (-C). Required for new sessions; optional when resuming via session_id.'),
      model: z.string().optional().describe('Optional Codex model override.'),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe('Optional per-request override for model_reasoning_effort (e.g. low, medium, high).'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      review: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({
    session_id,
    change_summary,
    test_results,
    open_questions,
    cwd,
    model,
    reasoning_effort,
    timeout_ms
  }) => {
    const effectiveSessionId = session_id ?? (cwd ? tryReadRepoSessionId(cwd) : undefined);
    const prompt = [
      'Reply in Chinese.',
      '## Change summary',
      change_summary.trim(),
      '',
      test_results ? `## Test results\n${test_results.trim()}\n` : '',
      open_questions ? `## Open questions\n${open_questions.trim()}\n` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const result = await enqueueBySession(effectiveSessionId, () =>
      runCodexOnce({
        sessionId: effectiveSessionId,
        toolName: 'codex_guard_final',
        cwd,
        prompt,
        model,
        reasoningEffort: reasoning_effort,
        timeoutMs: timeout_ms
      })
    );

    const structuredContent = {
      session_id: result.sessionId,
      review: result.reply,
      resume_command: `codex resume ${result.sessionId}`,
      usage: result.usage
    };

    return {
      content: [{ type: 'text', text: result.reply }],
      structuredContent
    };
  }
);

server.registerTool(
  'codex_review',
  {
    description: 'Ask Codex to review final changes (correctness, regressions, missing coverage).',
    inputSchema: {
      session_id: z.string().uuid().optional().describe('Optional Codex session id (UUID).'),
      change_summary: z.string().min(1).describe('What changed and why.'),
      test_results: z.string().optional().describe('Test results or commands run.'),
      open_questions: z.string().optional().describe('Anything uncertain that needs a decision.'),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe('Working root passed to Codex (-C). Required for new sessions; optional when resuming via session_id.'),
      model: z.string().optional().describe('Optional Codex model override.'),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe('Optional per-request override for model_reasoning_effort (e.g. low, medium, high).'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      review: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({
    session_id,
    change_summary,
    test_results,
    open_questions,
    cwd,
    model,
    reasoning_effort,
    timeout_ms
  }) => {
    const effectiveSessionId = session_id ?? (cwd ? tryReadRepoSessionId(cwd) : undefined);
    const prompt = [
      'Reply in Chinese.',
      '## Change summary',
      change_summary.trim(),
      '',
      test_results ? `## Test results\n${test_results.trim()}\n` : '',
      open_questions ? `## Open questions\n${open_questions.trim()}\n` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const result = await enqueueBySession(effectiveSessionId, () =>
      runCodexOnce({
        sessionId: effectiveSessionId,
        toolName: 'codex_review',
        cwd,
        prompt,
        model,
        reasoningEffort: reasoning_effort,
        timeoutMs: timeout_ms
      })
    );

    const structuredContent = {
      session_id: result.sessionId,
      review: result.reply,
      resume_command: `codex resume ${result.sessionId}`,
      usage: result.usage
    };

    return {
      content: [{ type: 'text', text: result.reply }],
      structuredContent
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`codex-persistent-mcp running (cwd: ${SERVER_CWD})`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
