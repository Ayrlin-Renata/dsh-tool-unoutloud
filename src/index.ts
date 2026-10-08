/**
 * unoutloud — a DeepSeek Harness plugin that rescues turns which end with the
 * agent's tool call (or raw XML) written as plain assistant text.
 *
 * Failure mode: the model emits its tool call as visible chat text instead of
 * a real tool call. No tool calls means the harness treats the message as the
 * final response and closes the turn — the chat stalls with the intended tool
 * call never executed.
 *
 * Rescue flow (all inside `agent/turn-stopping`, which is serial and awaited
 * before the turn boundary commits):
 *   1. read the final assistant message of the closing turn from the session log,
 *   2. run the pure detector (`src/detect.ts`) — verdict: retryable / shaped /
 *      xml-only / none,
 *   3. steer a short "was that a mistake?" nudge back to the agent, which keeps
 *      the turn open (fresh steering runs another step),
 *   4. for `retryable`, register `retry_stray_call` so the model can execute
 *      the already-parsed call as a real tool call without retyping it.
 *
 * Safety rails: one nudge per turn, per-session caps and cooldown, interrupted
 * messages skipped, every listener wrapped so this plugin can never throw into
 * the agent loop, `dryRun` logs verdicts without steering.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { detect, DEFAULT_PATTERNS, DEFAULT_EXAMPLE_SKIP } from './detect.ts';
import { nudgeText } from './prompts.ts';

/** Cordis plugin id (also the patch-row target name). */
export const name = 'unoutloud';

/** Required services: the lazy retry tool dispatches through `ctx.tools`. */
export const inject = ['tools'];

/** Static config schema; patch rows and `--dump-config` see these defaults. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  toolName: z.string().default('retry_stray_call'),
  patterns: z.array(z.string()).default([...DEFAULT_PATTERNS]),
  exampleSkipRegex: z.string().default(DEFAULT_EXAMPLE_SKIP),
  xmlDominance: z.number().min(0).max(1).default(0.6),
  dryRun: z.boolean().default(false),
  maxNudgesPerSession: z.number().step(1).min(1).default(10),
  cooldownMs: z.number().step(1).min(0).default(15000),
  retryTtlMs: z.number().step(1).min(1000).default(300000),
  maxRetryAttempts: z.number().step(1).min(1).default(3),
});

/** Runtime shape `apply` reads; mirrors `Config` and survives a missing schema. */
export interface UnoutloudConfig {
  enabled: boolean;
  toolName: string;
  patterns: string[];
  exampleSkipRegex: string;
  xmlDominance: number;
  dryRun: boolean;
  maxNudgesPerSession: number;
  cooldownMs: number;
  retryTtlMs: number;
  maxRetryAttempts: number;
}

const DEFAULTS: UnoutloudConfig = {
  enabled: true,
  toolName: 'retry_stray_call',
  patterns: [...DEFAULT_PATTERNS],
  exampleSkipRegex: DEFAULT_EXAMPLE_SKIP,
  xmlDominance: 0.6,
  dryRun: false,
  maxNudgesPerSession: 10,
  cooldownMs: 15000,
  retryTtlMs: 300000,
  maxRetryAttempts: 3,
};

/** One stored stray call awaiting `retry_stray_call`, scoped to its session. */
interface PendingRetry {
  name: string;
  args: Record<string, unknown>;
  expiresAt: number;
  attempts: number;
}

interface SessionState {
  nudges: number;
  lastNudgeAt: number;
  lastNudgedTurn: number;
  /** Fingerprint of the last nudged stall (loop guard for steered-open turns). */
  lastNudgedFingerprint?: string;
  pending?: PendingRetry;
}

/** Join an assistant/user message's text blocks into one string. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function sessionIdOf(session: unknown): string {
  try {
    const s = session as { header?: { id?: unknown }; id?: unknown };
    return String(s?.header?.id ?? s?.id ?? '');
  } catch {
    return '';
  }
}

/** Cheap stable fingerprint of a stall (length + djb2 over the full text). */
function fingerprintOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Mount the plugin.
 * @param ctx - the composition context this fiber runs in.
 * @param config - validated config (or `{}` when the schema is unavailable).
 */
export function apply(ctx: Context, config?: Partial<UnoutloudConfig>): void {
  const cfg: UnoutloudConfig = { ...DEFAULTS, ...config };
  if (cfg.enabled === false) return;

  /** Session id → nudge counters and pending stray call. */
  const states = new Map<string, SessionState>();
  /** Dispose handle for the lazily registered retry tool, when registered. */
  let disposeRetryTool: (() => void) | null = null;
  /** Monotonic suffix for unique nested call ids. */
  let callSeq = 0;

  const log = (level: 'info' | 'warn' | 'debug', ...args: unknown[]): void => {
    try {
      const logger = (ctx as unknown as Record<string, unknown>).logger as
        | Record<string, ((...a: unknown[]) => void) | undefined>
        | undefined;
      logger?.[level]?.('[unoutloud]', ...args);
    } catch {
      /* logging must never throw */
    }
  };

  const getState = (sid: string): SessionState => {
    let st = states.get(sid);
    if (!st) {
      st = { nudges: 0, lastNudgeAt: 0, lastNudgedTurn: -1 };
      states.set(sid, st);
    }
    return st;
  };

  /**
   * Registered tool names as `scope` (pass the calling agent) sees them —
   * agent-plane tools are invisible to the global view, so the scoped view is
   * authoritative; the global view is only a fallback when the scoped call
   * itself throws. null = check unavailable (detection skips the check).
   */
  const registeredNames = (scope?: object): Set<string> | null => {
    const from = (list: unknown): Set<string> =>
      new Set((list as Array<{ name: string }>).map((s) => s.name));
    try {
      return from(ctx.tools.schemas(scope));
    } catch {
      try {
        return from(ctx.tools.schemas());
      } catch {
        return null;
      }
    }
  };

  /** True when any session still holds a live pending retry. */
  const anyPending = (): boolean => {
    const now = Date.now();
    for (const st of states.values()) {
      if (st.pending && st.pending.expiresAt > now) return true;
    }
    return false;
  };

  /** Dispose the retry tool whenever nothing is pending (its schema costs tokens). */
  const sweepRetryTool = (): void => {
    if (!disposeRetryTool || anyPending()) return;
    const dispose = disposeRetryTool;
    disposeRetryTool = null;
    try {
      dispose();
      log('debug', 'retry tool unregistered (no pending retries)');
    } catch (e) {
      log('warn', 'failed to dispose retry tool:', e);
    }
  };

  /** Register the retry tool on first retryable verdict; idempotent. */
  const ensureRetryTool = (): void => {
    if (disposeRetryTool) return;
    disposeRetryTool = ctx.tools.register(
      defineTool({
        name: cfg.toolName,
        description:
          `Execute the stray tool call detected in your previous reply — the one you wrote ` +
          `as plain text instead of a real tool call. Only call this right after the ` +
          `unoutloud wake-up says a retry is available: it re-runs the detected call ` +
          `(already parsed) through the normal tool pipeline as a real tool call. ` +
          `Optional arguments_override replaces the parsed arguments entirely when they ` +
          `were parsed wrong; otherwise omit it.`,
        parameters: {
          arguments_override: {
            type: 'json',
            description:
              'Optional replacement arguments (a JSON object) for the detected call. ' +
              'Omit to run the parsed arguments as-is.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              tool_name: { type: 'string', required: true },
              attempts: { type: 'integer', required: true },
              replay_content: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                required: true,
              },
            },
          },
          render: (_args: unknown, raw: unknown) => {
            const value = (raw ?? {}) as {
              status?: string;
              tool_name?: string;
              attempts?: number;
              replay_content?: unknown[];
            };
            const head = `retry_stray_call: ${value.status ?? 'done'} — re-ran '${
              value.tool_name ?? '?'
            }' (attempt ${value.attempts ?? '?'}).`;
            const blocks = Array.isArray(value.replay_content)
              ? ((value.replay_content as ContentBlock[]).filter(
                  (b) => b && typeof b.type === 'string',
                ) as ContentBlock[])
              : [];
            return [{ type: 'text' as const, text: head }, ...blocks] as ContentBlock[];
          },
        },
        async execute(args: { arguments_override?: unknown }, exec) {
          const agent = exec.agent;
          if (!agent) {
            throw new Error(
              'NO_AGENT: this call has no agent context, so there is no session to retry in. ' +
                'Redo the original action as a direct tool call instead.',
            );
          }
          const sid = sessionIdOf(agent.session);
          const st = getState(sid);
          const pending = st.pending;
          if (!pending) {
            throw new Error(
              `NO_PENDING: no stray tool call is pending in this session (already retried, ` +
                `expired, or never detected). Redo the original action as a direct tool call.`,
            );
          }
          const now = Date.now();
          if (now > pending.expiresAt) {
            st.pending = undefined;
            sweepRetryTool();
            throw new Error(
              `EXPIRED: the pending stray call exceeded retryTtlMs (${cfg.retryTtlMs}ms). ` +
                `Redo the original action as a direct tool call.`,
            );
          }
          if (pending.attempts >= cfg.maxRetryAttempts) {
            st.pending = undefined;
            sweepRetryTool();
            throw new Error(
              `MAX_ATTEMPTS: already retried ${pending.attempts} time(s) ` +
                `(maxRetryAttempts=${cfg.maxRetryAttempts}). Redo the original action directly.`,
            );
          }

          const override = args.arguments_override;
          const newArgs =
            override !== undefined && override !== null ? override : pending.args;
          if (!isPlainObject(newArgs)) {
            throw new Error('BAD_OVERRIDE: arguments_override must be a JSON object.');
          }
          pending.attempts += 1;
          const attemptsLeft = cfg.maxRetryAttempts - pending.attempts;

          let replay;
          try {
            replay = await ctx.tools.execute({
              callId: ToolCallId(`${String(exec.callId)}:unoutloud:${++callSeq}`),
              name: pending.name,
              arguments: newArgs,
              agent,
              rootCallId: exec.rootCallId,
              parent: exec.token,
              signal: exec.signal,
            });
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            throw new Error(`RETRY_FAILED: re-running '${pending.name}' threw: ${detail}`);
          }

          if (replay.isError) {
            const detail =
              textOf(replay.content).slice(0, 600) ||
              (replay.error && replay.error.message) ||
              'unknown error';
            throw new Error(
              `RETRY_FAILED: re-running '${pending.name}' failed: ${detail} ` +
                `(${attemptsLeft} attempt(s) left — you can call ${cfg.toolName} again with ` +
                `arguments_override to correct them, or run the tool directly).`,
            );
          }

          // Ferry nested-dispatch context back onto our own result, like any
          // composite tool must (deferContext / concludesTurn forwarding).
          for (const c of replay.additionalContexts ?? []) {
            try {
              exec.deferContext(c);
            } catch {
              /* ferrying is best-effort */
            }
          }
          if (replay.concludesTurn) {
            try {
              exec.concludeTurn();
            } catch {
              /* best-effort */
            }
          }

          st.pending = undefined;
          queueMicrotask(sweepRetryTool);
          return {
            status: 'retried',
            tool_name: pending.name,
            attempts: pending.attempts,
            // Canonical JSON value per the output schema: ContentBlock
            // interfaces have no index signature, so round-trip to plain
            // records (render() re-materializes them as ContentBlocks).
            replay_content: replay.content.map((b) => JSON.parse(JSON.stringify(b))),
          };
        },
      }),
    );
    log('debug', `retry tool '${cfg.toolName}' registered for pending call`);
  };

  // Drop per-session state (and the tool, when idle) once a session goes away.
  ctx.on('session/disposed', (session: unknown) => {
    try {
      states.delete(sessionIdOf(session));
      sweepRetryTool();
    } catch (e) {
      log('warn', 'session/disposed handler error:', e);
    }
  });

  // The rescue hook: serial, awaited before the turn boundary commits.
  // Payload typed from the event map (Agent / turn / signal).
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      if (cfg.enabled === false) return;
      const { agent, turn, signal } = payload;
      if (!agent || signal?.aborted) return;

      const sid = sessionIdOf(agent.session);
      const st = getState(sid);

      // Expire this session's stale pending (also drives tool disposal).
      if (st.pending && st.pending.expiresAt <= Date.now()) {
        st.pending = undefined;
        sweepRetryTool();
      }

      // Loop guards: per-session cap and cooldown. The same-stall guard lives
      // next to the text fingerprint below — a steer keeps the SAME turn number
      // open across many steps, so a blanket per-turn lockout would swallow a
      // second, genuinely different stall minutes later.
      if (st.nudges >= cfg.maxNudgesPerSession) {
        log('debug', `skip turn ${turn}: session cap ${cfg.maxNudgesPerSession} reached`);
        return;
      }
      if (st.lastNudgeAt > 0 && Date.now() - st.lastNudgeAt < cfg.cooldownMs) {
        log('debug', `skip turn ${turn}: cooldown ${cfg.cooldownMs}ms not elapsed`);
        return;
      }

      const session = agent.session as {
        snapshotEvents?: () => readonly unknown[];
        events?: readonly unknown[];
      };
      const events =
        typeof session?.snapshotEvents === 'function'
          ? session.snapshotEvents()
          : Array.isArray(session?.events)
            ? session.events
            : [];
      if (!Array.isArray(events) || events.length === 0) {
        log('debug', `skip turn ${turn}: no session events visible`);
        return;
      }

      // Walk backwards: the closing turn's final assistant message, and the
      // latest direct-user prompt (for the example-skip guard).
      type Evt = { type?: string; data?: Record<string, unknown> };
      let lastAsst: Evt | undefined;
      let lastUser: Evt | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i] as Evt;
        if (!lastAsst && e?.type === 'assistant/message') {
          if (e.data && (e.data.turn as number) === turn) lastAsst = e;
          else if (e.data && (e.data.turn as number) !== turn) {
            // The closing turn produced no assistant message at all.
            log('debug', `skip turn ${turn}: latest assistant message belongs to another turn`);
            return;
          }
        }
        if (e?.type === 'user/message' && (e.data?.source as { kind?: string } | undefined)?.kind === 'user') {
          lastUser = e;
          if (lastAsst) break;
        }
        if (lastAsst && lastUser) break;
      }
      if (!lastAsst) {
        log('debug', `skip turn ${turn}: no assistant message found for the closing turn`);
        return;
      }
      if (lastAsst.data?.interrupted) {
        log('debug', `skip turn ${turn}: final assistant message is interrupted`);
        return;
      }

      const content = lastAsst.data?.message as { content?: unknown[] } | undefined;
      const blocks = Array.isArray(content?.content) ? content.content : null;
      if (!blocks) return;
      // Real tool calls in the final message mean the turn ended by tool
      // design (concludesTurn), not by a text-only stall — leave it alone.
      if (blocks.some((b) => (b as { type?: string })?.type === 'tool-call')) {
        log('debug', `skip turn ${turn}: final message carries real tool-call blocks`);
        return;
      }

      const text = textOf(blocks);
      if (text.trim() === '') {
        log('debug', `skip turn ${turn}: final message has no text blocks`);
        return;
      }

      // Same-turn re-nudge policy: block only a repeat of the SAME stall text
      // (the loop this guard exists for). A different stall in a steered-open
      // turn is a new mistake and gets its own nudge — still bounded by the
      // session cap and cooldown above.
      const fingerprint = fingerprintOf(text);
      if (st.lastNudgedTurn === turn && st.lastNudgedFingerprint === fingerprint) {
        log('debug', `skip turn ${turn}: identical stall already nudged this turn`);
        return;
      }

      const lastUserText = lastUser ? textOf(lastUser.data?.content) : '';
      const registered = registeredNames(agent);
      const verdict = detect(
        { text, lastUserText },
        {
          patterns: cfg.patterns,
          exampleSkipRegex: cfg.exampleSkipRegex,
          xmlDominance: cfg.xmlDominance,
          isToolRegistered: registered ? (n) => registered.has(n) : undefined,
        },
      );
      if (verdict.kind === 'none') return;

      const nudge = nudgeText(verdict, cfg.toolName);
      if (cfg.dryRun) {
        log('info', `dryRun: turn ${turn} verdict=${verdict.kind} — nudge would be: ${nudge}`);
        return;
      }

      if (verdict.kind === 'retryable') {
        st.pending = {
          name: verdict.name,
          args: verdict.args,
          expiresAt: Date.now() + cfg.retryTtlMs,
          attempts: 0,
        };
        ensureRetryTool();
      } else {
        // A non-retryable verdict must not leave a stale pending behind.
        st.pending = undefined;
        sweepRetryTool();
      }

      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: nudge }],
          source: { kind: 'plugin', plugin: name },
        }),
      );

      st.lastNudgedTurn = turn;
      st.lastNudgedFingerprint = fingerprint;
      st.nudges += 1;
      st.lastNudgeAt = Date.now();
      log(
        'info',
        `nudged turn ${turn} verdict=${verdict.kind}` +
          (verdict.kind === 'retryable' ? ` tool=${verdict.name}` : ''),
      );
    } catch (e) {
      // The plugin must never throw into the agent loop.
      log('warn', 'turn-stopping handler error:', e);
    }
  });

  // Ensure the tool unregisters with the fiber even if sessions linger.
  ctx.effect(() => () => {
    if (disposeRetryTool) {
      const dispose = disposeRetryTool;
      disposeRetryTool = null;
      try {
        dispose();
      } catch {
        /* teardown is best-effort */
      }
    }
  });

  log('info', `mounted (dryRun=${cfg.dryRun})`);
}

// Re-exported for tests and other plugins.
export { detect, DEFAULT_PATTERNS, DEFAULT_EXAMPLE_SKIP } from './detect.ts';
export { nudgeText } from './prompts.ts';
