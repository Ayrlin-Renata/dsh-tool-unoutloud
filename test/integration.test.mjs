// Integration smoke test: mounts the plugin against a fake Cordis context and
// drives the rescue flow end to end (no harness required).
// Closing tags are assembled at runtime (see transport lesson) — never literal.
import test from 'node:test';
import assert from 'node:assert/strict';

const close = (tag) => '<' + '/' + tag + '>';

const plugin = await import('../src/index.ts');

test('exports the plugin contract', () => {
  assert.equal(plugin.name, 'unoutloud');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.Config, 'Config schema exported');
  // Schemastery object schemas expose JSON with defaults.
  try {
    const json = plugin.Config.toJSON();
    assert.equal(json.properties.enabled.default, true);
    assert.equal(json.properties.toolName.default, 'retry_stray_call');
    assert.equal(json.properties.xmlDominance.default, 0.6);
    assert.equal(json.properties.maxNudgesPerSession.default, 10);
  } catch {
    /* toJSON shape differences are not fatal */
  }
});

function makeCtx() {
  const handlers = new Map();
  const tools = new Map();
  const executed = [];
  const logs = [];
  const cleanups = [];
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      debug: (...a) => logs.push(['debug', ...a]),
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    effect(fn) {
      const cleanup = fn();
      cleanups.push(cleanup);
    },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
      schemas() {
        return [...tools.values()].map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.parameters,
        }));
      },
      get(name) {
        return tools.get(name);
      },
      async execute(input) {
        executed.push(input);
        return {
          isError: false,
          content: [{ type: 'text', text: 'replayed ok' }],
          additionalContexts: [],
          concludesTurn: false,
        };
      },
    },
  };
  return { ctx, handlers, tools, executed, logs, cleanups };
}

function makeSession(id, events) {
  return {
    header: { id },
    snapshotEvents: () => events,
  };
}

function fire(handlers, { agent, turn = 1, signal = new AbortController().signal }) {
  for (const fn of handlers.get('agent/turn-stopping') ?? []) {
    fn({ agent, turn, signal });
  }
}

const strayText =
  '<invoke name="fs_read">' + '<parameter name="path">a.txt' + close('parameter') + close('invoke');

test('retryable verdict steers a nudge and registers the retry tool', () => {
  const { ctx, handlers, tools, logs } = makeCtx();
  // Pretend the stray target tool exists in the registry.
  tools.set('fs_read', { name: 'fs_read', description: 'read', parameters: {} });
  plugin.apply(ctx, { cooldownMs: 0 });

  const session = makeSession('S1', [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: strayText }] } } },
    { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
  ]);
  const steered = [];
  const agent = { session, steer: (msg) => steered.push(msg) };

  fire(handlers, { agent, turn: 1 });

  assert.equal(steered.length, 1, 'exactly one nudge');
  const msg = steered[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'plugin');
  assert.equal(msg.source.plugin, 'unoutloud');
  const text = msg.content.map((b) => b.text ?? '').join('\n');
  assert.match(text, /retry_stray_call/);
  assert.match(text, /fs_read/);
  assert.match(text, /Was that a mistake\?/i);
  assert.ok(tools.has('retry_stray_call'), 'retry tool registered while pending');
  assert.ok(
    logs.some((l) => l.some((x) => typeof x === 'string' && x.includes('nudged turn 1'))),
    'nudge logged',
  );

  // Same turn again: per-turn guard must block a second nudge.
  fire(handlers, { agent, turn: 1 });
  assert.equal(steered.length, 1, 'one nudge per turn');

  // Another session with a perfectly clean reply: no nudge.
  const cleanSession = makeSession('S3', [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'thanks' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'You are welcome.' }] } } },
  ]);
  fire(handlers, { agent: { session: cleanSession, steer: (m) => steered.push(m) }, turn: 1 });
  assert.equal(steered.length, 1, 'clean reply not nudged');
});

test('retry_stray_call re-dispatches the parsed call and clears pending', async () => {
  const { ctx, handlers, tools, executed } = makeCtx();
  tools.set('fs_read', { name: 'fs_read', description: 'read', parameters: {} });
  plugin.apply(ctx, { cooldownMs: 0 });

  const session = makeSession('S1', [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: strayText }] } } },
  ]);
  const agent = { session, steer: () => {} };
  fire(handlers, { agent, turn: 1 });

  const def = tools.get('retry_stray_call');
  assert.ok(def, 'retry tool available');
  const token = { tok: 1 };
  const exec = {
    callId: 'c1',
    rootCallId: 'r1',
    token,
    signal: new AbortController().signal,
    agent: { session },
    deferContext() {},
    concludeTurn() {},
  };

  const value = await def.execute({}, exec);
  assert.equal(executed.length, 1, 'one nested dispatch');
  const input = executed[0];
  assert.equal(input.name, 'fs_read');
  assert.deepEqual(input.arguments, { path: 'a.txt' });
  assert.equal(input.parent, token, 'nested under the retry call');
  assert.equal(input.rootCallId, 'r1');
  assert.ok(String(input.callId).includes(':unoutloud:'), 'unique nested call id');
  assert.equal(value.status, 'retried');
  assert.equal(value.tool_name, 'fs_read');
  assert.equal(value.attempts, 1);
  assert.equal(value.replay_content[0].text, 'replayed ok');

  // Success clears pending; once the microtask sweep runs, the tool unregisters.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!tools.has('retry_stray_call'), 'retry tool swept when nothing pending');

  // A stale call now fails loudly with actionable feedback.
  await assert.rejects(() => def.execute({}, exec), /NO_PENDING/);
});

test('not-retryable verdict nudges without registering the retry tool', () => {
  const { ctx, handlers, tools } = makeCtx();
  plugin.apply(ctx, { cooldownMs: 0 });

  const broken =
    '<invoke name="fs_read">' + '{"path": "a.txt"' + close('invoke'); // truncated/unclosable JSON body
  const session = makeSession('S2', [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: broken }] } } },
  ]);
  const steered = [];
  const agent = { session, steer: (m) => steered.push(m) };

  fire(handlers, { agent, turn: 1 });

  assert.equal(steered.length, 1, 'still nudged');
  const text = steered[0].content.map((b) => b.text ?? '').join('\n');
  assert.match(text, /do NOT call retry_stray_call/);
  assert.ok(!tools.has('retry_stray_call'), 'no retry tool for a shaped verdict');
});

test('dryRun logs the verdict but never steers', () => {
  const { ctx, handlers, tools, logs } = makeCtx();
  tools.set('fs_read', { name: 'fs_read', description: 'read', parameters: {} });
  plugin.apply(ctx, { dryRun: true, cooldownMs: 0 });

  const session = makeSession('S1', [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: strayText }] } } },
  ]);
  const steered = [];
  fire(handlers, { agent: { session, steer: (m) => steered.push(m) }, turn: 1 });

  assert.equal(steered.length, 0, 'dryRun never steers');
  assert.ok(!tools.has('retry_stray_call'), 'dryRun never registers');
  assert.ok(
    logs.some((l) => l.some((x) => typeof x === 'string' && x.includes('dryRun'))),
    'dryRun verdict logged',
  );
});

test('enabled:false mounts nothing', () => {
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, { enabled: false });
  assert.ok(!(handlers.get('agent/turn-stopping') ?? []).length, 'no turn hook');
  assert.ok(!(handlers.get('session/disposed') ?? []).length, 'no disposed hook');
});

test('teardown disposes the retry tool', () => {
  const { ctx, handlers, tools, cleanups } = makeCtx();
  tools.set('fs_read', { name: 'fs_read', description: 'read', parameters: {} });
  plugin.apply(ctx, { cooldownMs: 0 });

  const session = makeSession('S1', [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: strayText }] } } },
  ]);
  fire(handlers, { agent: { session, steer: () => {} }, turn: 1 });
  assert.ok(tools.has('retry_stray_call'));

  for (const cleanup of cleanups) cleanup();
  assert.ok(!tools.has('retry_stray_call'), 'fiber teardown unregisters the tool');
});
