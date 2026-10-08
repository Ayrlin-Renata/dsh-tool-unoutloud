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

  | verdict     | meaning                                                          | action |
  |-------------|------------------------------------------------------------------|--------|
  | `none`      | normal reply                                                     | nothing |
  | `retryable` | parses, fixes, and the tool is registered                        | nudge + register `retry_stray_call` |
  | `shaped`    | looks like a call but can't be retried (bad JSON, no name, tool not registered…) | nudge **with the reason** and an explicit "do not call the retry tool" |
  | `xml-only`  | reply is raw markup with no readable prose                       | nudge, no retry tool |

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

## Install

> **Why there are two routes:** Node refuses to type-strip `.ts` under
> `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a *package*
> install must load the built `dist/index.js`. The *scratch* route mounts
> `src/index.ts` by absolute path (outside `node_modules`) and needs no build.

### Option A — scratch mount (recommended for development)

Append one row to your **profile's** `cordis.patch.yml`
(`%DSH_HOME%\profiles\web\cordis.patch.yml`):

```yaml
  - insert:
      - id: unoutloud
        name: 'F:/Fun/Tools/DeepSeekHarness/dsh-tool-unoutloud/src/index.ts'
```

Profile patches hot-reload on save — edit `src/*.ts`, save, and the plugin
reloads. Config via a `config:` field on the same row (see below).

### Option B — link install (package route)

```sh
npm run build            # emits dist/*.js (Node built-in type stripping, no deps)
dsh plugin --profile web add link:F:/Fun/Tools/DeepSeekHarness/dsh-tool-unoutloud
```

and mount it by package name:

```yaml
  - insert:
      - id: unoutloud
        name: 'dsh-tool-unoutloud'
        config:
          enabled: true
```

`main`/`exports` point at `dist/index.js`. **Re-run `npm run build` after
editing `src/`** — link installs don't see source edits until rebuilt.

## Config

| knob | default | meaning |
|------|---------|---------|
| `enabled` | `true` | master switch (`false` mounts nothing) |
| `toolName` | `retry_stray_call` | retry tool's name |
| `patterns` | 6 built-ins | regex sources scanned for stray calls |
| `exampleSkipRegex` | built-in | user-prompt guard ("show me an example…") |
| `xmlDominance` | `0.6` | min tag-char ratio for the `xml-only` verdict |
| `dryRun` | `false` | log the verdict, never steer |
| `maxNudgesPerSession` | `10` | per-session nudge cap |
| `cooldownMs` | `15000` | minimum gap between nudges |
| `retryTtlMs` | `300000` | pending retry window |
| `maxRetryAttempts` | `3` | retry attempts before giving up |

## Verify

```sh
npm test        # build + 36 tests: detector fixtures, plugin wiring, dist load

# strict type-check (editor-facing):
pnpm dlx --package=typescript@5.9.2 tsc --noEmit --strict --skipLibCheck \
  --target es2022 --module esnext --moduleResolution bundler \
  --allowImportingTsExtensions --lib es2022,dom src/index.ts

dsh --profile web --dump-config | Select-String unoutloud   # mounted?
```

Then trigger a stall (or just inspect logs) — a rescue logs
`nudged turn N verdict=…`; `dryRun: true` logs verdicts without steering.

## Rollback

- Option A: delete the `insert` row from the profile's `cordis.patch.yml`.
- Option B: delete the row, then `dsh plugin --profile web remove dsh-tool-unoutloud`.

## Files

```
src/detect.ts            pure verdict engine (zero imports; unit-tested)
src/prompts.ts           three nudge templates
src/index.ts             plugin: config schema, turn-stopping hook, lazy retry tool
scripts/build.mjs        src/ → dist/ via node:module.stripTypeScriptTypes (no deps)
dist/*.js                built artifacts (what node_modules installs load)
test/detect.test.mjs     28 fixtures for the detector + nudge wording
test/integration.test.mjs  7 fixtures driving apply() against a fake context
                           (steer → guards → retry re-dispatch → teardown)
test/dist.test.mjs       1 fixture: the built artifact loads as plain JS
package.json             manifest (+ dsh.bundle.patch for the link/bundle route)
cordis.patch.yml         insert row for the link/bundle route
```

> `test/integration.test.mjs` imports the real plugin, which needs
> `@deepseek-ai/*` bare imports resolvable; the workspace `node_modules` is a
> junction to the profile's `@deepseek-ai` closure (or run the link install).

## Limitations

- Targets **native tool mode**; under PTC a root model-direct call would be
  denied (`UNKNOWN_TOOL`) — the nested re-dispatch mirrors `dsh-tool-retry`,
  which does run under the profile, but PTC is untested here.
- Only **turn-final** stray output is nudged (mid-turn stray XML is out of
  scope by design).
- One nudge per turn; a second mistake in the same turn is not re-nudged.
- The registered-tool check uses the global registry view; a tool registered
  only in another scope may downgrade `retryable` → `shaped` (safe direction).
- While a retry is pending, `retry_stray_call` is visible in all sessions
  (calls from other sessions fail with `NO_PENDING`).
- Complements `@canglongcl/dsh-tool-retry` (checkpoint/replay of *failed* tool
  calls) — different failure mode, no overlap.

## License

MIT
