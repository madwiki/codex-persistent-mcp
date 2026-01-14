#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const WORKSPACE_ROOT = process.env.CODEX_MCP_CWD ?? process.cwd();
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const DEFAULT_TIMEOUT_MS = 120_000;

type CodexArgsInput = {
  sessionId?: string;
  prompt: string;
  model?: string;
};

function buildCodexArgs({ sessionId, prompt, model }: CodexArgsInput): string[] {
  const base = [
    'exec',
    '--skip-git-repo-check',
    '--json',
    '-C',
    WORKSPACE_ROOT
  ];

  if (model) base.push('-m', model);

  if (sessionId) return [...base, 'resume', sessionId, prompt];
  return [...base, prompt];
}

type CodexRunInput = {
  sessionId?: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
};

type CodexRunResult = {
  sessionId: string;
  reply: string;
  usage?: unknown;
};

async function runCodexOnce({
  sessionId,
  prompt,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: CodexRunInput): Promise<CodexRunResult> {
  const args = buildCodexArgs({ sessionId, prompt, model });

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
  version: '0.1.0'
});

server.registerTool(
  'codex_chat',
  {
    description:
      'Chat with Codex CLI using a real persisted session that can be resumed via `codex resume <session_id>`.',
    inputSchema: {
      session_id: z.string().uuid().optional().describe('Existing Codex session id (UUID).'),
      prompt: z.string().min(1).describe('User message to send to Codex.'),
      model: z.string().optional().describe('Optional Codex model override.'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      reply: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({ session_id, prompt, model, timeout_ms }) => {
    const result = await enqueueBySession(session_id, () =>
      runCodexOnce({ sessionId: session_id, prompt, model, timeoutMs: timeout_ms })
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
      model: z.string().optional().describe('Optional Codex model override.'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      critique: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({ session_id, requirements, plan, constraints, model, timeout_ms }) => {
    const prompt = [
      'You are Codex acting as a strict senior engineering reviewer.',
      'Respond in Chinese.',
      '',
      'Please critique the proposed plan. Focus on:',
      '1) Missing requirements and edge cases',
      '2) Risks / failure modes (including memory/compact pitfalls)',
      '3) Questions to clarify before implementation',
      '4) Suggested test plan and validation steps',
      '',
      '## Requirements',
      requirements.trim(),
      '',
      constraints ? `## Constraints\n${constraints.trim()}\n` : '',
      '## Proposed plan',
      plan.trim()
    ]
      .filter(Boolean)
      .join('\n');

    const result = await enqueueBySession(session_id, () =>
      runCodexOnce({ sessionId: session_id, prompt, model, timeoutMs: timeout_ms })
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
      model: z.string().optional().describe('Optional Codex model override.'),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe('Execution timeout.')
    },
    outputSchema: {
      session_id: z.string().uuid(),
      review: z.string(),
      resume_command: z.string(),
      usage: z.any().optional()
    }
  },
  async ({ session_id, change_summary, test_results, open_questions, model, timeout_ms }) => {
    const prompt = [
      'You are Codex acting as a strict senior engineering reviewer.',
      'Respond in Chinese.',
      '',
      'Review the final state of work. Focus on:',
      '1) Whether the changes satisfy the stated goal',
      '2) Likely regressions / edge cases',
      '3) Missing tests or validation steps',
      '4) Release / rollback considerations',
      '',
      '## Change summary',
      change_summary.trim(),
      '',
      test_results ? `## Test results\n${test_results.trim()}\n` : '',
      open_questions ? `## Open questions\n${open_questions.trim()}\n` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const result = await enqueueBySession(session_id, () =>
      runCodexOnce({ sessionId: session_id, prompt, model, timeoutMs: timeout_ms })
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
  console.error(`codex-persistent-mcp running (cwd: ${WORKSPACE_ROOT})`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
