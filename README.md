# dsh-tool-unoutloud

A DeepSeek Harness plugin that rescues the "tool call spoken out loud" failure:
the model writes its tool call (or raw XML) as **plain assistant chat text**
instead of making a real tool call. No tool call ⇒ the harness treats the
message as the final response and closes the turn — the chat stalls, and the
intended tool never runs.

When that happens at the end of a turn, `unoutloud`:

1. **detects** the stray call / raw XML in the closing assistant message,
2. **steers** a short (~60 token) nudge back to the agent — *"was that a
   mistake?"* — which keeps the turn open so the agent can react,
3. when the stray call is **parseable and its tool is registered**, registers a
   low-token `retry_stray_call` tool so the agent can execute the already-parsed
   call as a real tool call without retyping it,
4. when it is **not** parseable (or the tool is unknown), the nudge says so
   explicitly — *"do NOT call retry_stray_call"* — so the agent never attempts
   a retry that cannot work, and instead redoes the call itself.

## How it works

Everything runs inside `agent/turn-stopping` (serial, awaited before the turn
boundary commits):

- The final `assistant/message` of the closing turn is read from the session
  log (`session.snapshotEvents()`).
- The pure detector (`src/detect.ts`) returns one of four verdicts:

  | verdict      | meaning                                                        | action |
  |--------------|----------------------------------------------------------------|--------|
  | `none`       | normal reply                                                   | nothing |
  | `retryable`  parses, fixes, and the tool is registered             | nudge + register `retry_stray_call` |
  | `shaped`     looks like a call but can't be retried (bad JSON, no name, tool not registered…) | nudge **with the reason** and an explicit "do not call the retry tool" |
  | `xml-only`   reply is raw markup with no readable prose            | nudge, no retry tool |

- `src/prompts.ts` renders the verdict-specific nudge; it is steered as a
  plugin-sourced message via `agent.steer(...)`, which keeps the turn open.

### Parsing / "fixable" handling

Recognized stray shapes: `<invoke name="…">` (+ `<parameter>` entries,
`arguments="…"` attributes, JSON bodies), `<function_calls>` / `<tool_use>` /
`<tool_calls>` wrappers, and JSON call objects
(`{"name": …, "arguments": …}`, Claude-style `{"type":"tool_use", …,"input":…}`).
Fix-ups: XML-entity decoding (`&lt;`…), markdown-fence stripping, trailing
commas, single-quote JSON, JSON-in-string arguments, unterminated (cut-off)
calls, and numeric/boolean/JSON parameter values.

### Safety rails

- **one nudge per turn**, per-session cap (default 10), cooldown (default 15 s),
- `interrupted` assistant messages are never judged,
- replies containing real `tool-call` blocks are left alone (that turn ended by
  tool design, not by a text-only stall),
- examples are protected: calls buried in prose or inside markdown fences are
  skipped, and `exampleSkipRegex` is tested against the last *direct user*
  prompt ("show me an example…"),
- the retry tool is registered **lazily** and unregistered when nothing is
  pending (its schema would otherwise cost tokens on every request),
- pending calls expire (`retryTtlMs`, default 5 min) and are single-shot on
  success, capped at `maxRetryAttempts` (default 3),
- every listener is wrapped in try/catch — the plugin can never throw into the
  agent loop, and the detector is written to degrade to `none` on any internal
  error,
- the re-dispatch goes through the **full tool pipeline** (permissions, policy)
  as a nested call (`parent: exec.token`), and nested results
  (`additionalContexts`, `concludesTurn`) are ferried back to the retry tool's
  own result.

## Files

```
src/detect.ts     pure verdict engine (zero imports; unit-tested)
src/prompts.ts    three nudge templates
src/index.ts      plugin: config schema, turn-stopping hook, lazy retry tool
test/detect.test.mjs         28 fixtures for the detector + nudge wording
test/integration.test.mjs    7 fixtures driving apply() against a fake context
                             (steer → guards → retry re-dispatch → teardown)
package.json      manifest (+ dsh.bundle.patch for the link/bundle route)
cordis.patch.yml  insert row for the link/bundle route
```

> `test/integration.test.mjs` imports the real plugin, which needs
> `@deepseek-ai/*` bare imports resolvable; the workspace `node_modules` is a
> junction to the profile's `@deepseek-ai` closure (or run the link install).
