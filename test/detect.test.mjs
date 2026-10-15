import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, DEFAULT_EXAMPLE_SKIP, DEFAULT_PATTERNS } from '../src/detect.ts';
import { nudgeText } from '../src/prompts.ts';

/**
 * Closing-tag helper: fixture strings assemble their closing tags at runtime
 * so this file itself never needs raw closing-tag literals.
 */
const close = (tag) => '<' + '/' + tag + '>';

const INVOKE = `<invoke name="read_file"><parameter name="path">F:\\repo\\a.txt` + close('parameter') + close('invoke');
const INVOKE_UNTERMINATED = `<invoke name="read_file"><parameter name="path">F:\\repo\\a.txt` + close('parameter');
const PROSE = 'Sure thing — first I need to load the file into memory before I can answer questions about it. ';

test('retryable: invoke block with parameter entries', () => {
  const v = detect({ text: 'On it.\n' + INVOKE });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'read_file');
  assert.deepEqual(v.args, { path: 'F:\\repo\\a.txt' });
});

test('retryable: unterminated invoke (cut off mid-reply) still parses', () => {
  const v = detect({ text: INVOKE_UNTERMINATED });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'read_file');
  assert.deepEqual(v.args, { path: 'F:\\repo\\a.txt' });
});

test('retryable: fenced JSON call (whole reply is one fence)', () => {
  const v = detect({ text: '```json\n{"name": "web_search", "arguments": {"q": "deepseek harness"}}\n```' });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'web_search');
  assert.deepEqual(v.args, { q: 'deepseek harness' });
});

test('retryable: entity-escaped call decodes before parsing', () => {
  const text =
    'I will search.\n' +
    '&lt;invoke name=&quot;web_search&quot;&gt;' +
    '&lt;parameter name=&quot;q&quot;&gt;dsh plugins&lt;/parameter&gt;' +
    '&lt;/invoke&gt;';
  const v = detect({ text });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'web_search');
  assert.deepEqual(v.args, { q: 'dsh plugins' });
});

test('retryable: JSON tool_use content-block shape with input key', () => {
  const v = detect({ text: '{"type": "tool_use", "name": "bash", "input": {"command": "ls"}}' });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'bash');
  assert.deepEqual(v.args, { command: 'ls' });
});

test('retryable: function_calls wrapper recurses into invoke', () => {
  const text =
    '<function_calls>' + `<invoke name="get_time">` + close('invoke') + close('function_calls');
  const v = detect({ text });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'get_time');
  assert.deepEqual(v.args, {});
});

test('retryable: invoke with JSON body and trailing comma gets fixed', () => {
  const text = `<invoke name="web_search">{"q": "dsh", "limit": 3,}` + close('invoke');
  const v = detect({ text });
  assert.equal(v.kind, 'retryable');
  assert.equal(v.name, 'web_search');
  assert.deepEqual(v.args, { q: 'dsh', limit: 3 });
});

test('shaped: unparseable arguments produce a reason, never retryable', () => {
  const text = `<invoke name="web_search">{"q": broken}` + close('invoke');
  const v = detect({ text });
  assert.equal(v.kind, 'shaped');
  assert.equal(typeof v.reason, 'string');
  assert.ok(v.reason.length > 0);
});

test('shaped: invoke without a name attribute produces a reason', () => {
  const text = `<invoke>` + `<parameter name="path">a.txt` + close('parameter') + close('invoke');
  const v = detect({ text });
  assert.equal(v.kind, 'shaped');
  assert.match(v.reason, /name attribute/);
});

test('shaped: prose lead-in ending in a closing-tag tail (opening never emitted)', () => {
  const text =
    'Here is the snippet you asked for:\n\n' +
    close('parameter') + '\n' + close('invoke') + '\n```\n' + close('assistant');
  const v = detect({ text });
  assert.equal(v.kind, 'shaped');
  assert.match(v.reason, /closing tags/);
});

test('xml-only: closing-tag tail with no prose (real session shape)', () => {
  const text =
    '\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n' +
    close('parameter') + '\n' + close('invoke') + '\n```\n\n' + close('assistant');
  const v = detect({ text });
  assert.equal(v.kind, 'xml-only');
});

test('xml-only: doubled closing-tag tail with a fence between', () => {
  const text =
    close('parameter') + '\n' + close('invoke') + '\n```\n' + close('assistant') + '\n' +
    '\n'.repeat(15) +
    close('parameter') + '\n' + close('invoke') + '\n```';
  const v = detect({ text });
  assert.equal(v.kind, 'xml-only');
});

test('none: prose that merely mentions a closing tag keeps trailing prose', () => {
  const text =
    'You close the block with ' + close('invoke') + ' and then your reply continues as normal.';
  const v = detect({ text });
  assert.equal(v.kind, 'none');
});

test('shaped: parsed call targeting an unregistered tool reports it', () => {
  const v = detect({ text: INVOKE }, { isToolRegistered: (n) => n === 'some_other_tool' });
  assert.equal(v.kind, 'shaped');
  assert.match(v.reason, /not registered/);
  assert.match(v.reason, /read_file/);
});

test('xml-only: dominant raw markup with no call shape', () => {
  const text = '<result><value>42' + close('value') + close('result');
  const v = detect({ text });
  assert.equal(v.kind, 'xml-only');
});

test('none: ordinary prose reply', () => {
  assert.equal(detect({ text: 'The fix is in src/index.ts — I patched the guard clause.' }).kind, 'none');
});

test('none: empty / whitespace reply', () => {
  assert.equal(detect({ text: '' }).kind, 'none');
  assert.equal(detect({ text: '   \n\t  ' }).kind, 'none');
});

test('none: interrupted assistant message is never nudged', () => {
  const v = detect({ text: INVOKE, interrupted: true });
  assert.equal(v.kind, 'none');
});

test('none: fenced call buried in prose is a deliberate example', () => {
  const text =
    PROSE +
    'If you ever need to read a file you would write it like this: ```xml\n' +
    INVOKE +
    '\n```' +
    ' and the harness executes it for you.' +
    PROSE;
  assert.equal(detect({ text }).kind, 'none');
});

test('none: unfenced inline example deep in prose (lead-in guard)', () => {
  const longProse = PROSE.repeat(6); // ~540 chars of lead-in
  const v = detect({ text: longProse + INVOKE });
  assert.equal(v.kind, 'none');
});

test('none: user asked for an example (example-skip guard)', () => {
  const v = detect({ text: INVOKE, lastUserText: 'Show me an example of a tool call for the docs.' });
  assert.equal(v.kind, 'none');
});

test('example-skip guard does not block normal detection', () => {
  const v = detect({ text: INVOKE, lastUserText: 'read the file and summarize it' });
  assert.equal(v.kind, 'retryable');
});

test('custom exampleSkipRegex replaces the default', () => {
  const v = detect(
    { text: INVOKE, lastUserText: 'zzz nothing relevant here' },
    { exampleSkipRegex: 'nothing relevant' },
  );
  assert.equal(v.kind, 'none');
});

test('example-skip: word buried mid-paste in a long prompt does NOT disable detection', () => {
  // The nialyns-razor regression: a 46KB advice paste quoted "For example" at
  // index 21k; the real ask sat in the first ~200 chars.
  const paste =
    'Here is the research you asked for. '.repeat(40) +
    'For example, "the scent of" is not inherently bad. ' +
    'More quoted advice follows. '.repeat(40);
  assert.ok(paste.length > 600, 'fixture is a long paste');
  const v = detect({ text: INVOKE, lastUserText: paste });
  assert.equal(v.kind, 'retryable', 'a mid-paste "For example" must not zero detection');
});

test('example-skip: ask at the tail (context paste, then the request) still disables', () => {
  const filler = 'context context context '.repeat(40);
  const v = detect({ text: INVOKE, lastUserText: filler + 'now show me an example of that tag' });
  assert.equal(v.kind, 'none');
});

test('example-skip: ask at the head of a long prompt still disables', () => {
  const filler = 'context context context '.repeat(40);
  const v = detect({ text: INVOKE, lastUserText: 'show me an example of that tag first. ' + filler });
  assert.equal(v.kind, 'none');
});

test('custom patterns extend detection; unparseable custom match degrades to shaped', () => {
  const opts = { patterns: ['TOOLCALL:\\s*\\w+'] };
  const v = detect({ text: 'TOOLCALL: read_file something happened' }, opts);
  assert.equal(v.kind, 'shaped');
});

test('invalid pattern sources are skipped, not thrown', () => {
  // With one bad source among good ones, detection still works:
  const v = detect({ text: INVOKE }, { patterns: ['([unclosed', ...DEFAULT_PATTERNS] });
  assert.equal(v.kind, 'retryable');
  // A wholly-invalid pattern list must not crash and still yields a rescue
  // verdict (xml-only nudge without the retry tool):
  const allBad = detect({ text: INVOKE }, { patterns: ['([unclosed'] });
  assert.ok(['xml-only', 'shaped', 'retryable'].includes(allBad.kind));
});

test('detector never throws on hostile input', () => {
  assert.equal(detect(undefined).kind, 'none');
  assert.equal(detect({}).kind, 'none');
  assert.equal(detect({ text: null }).kind, 'none');
  assert.equal(detect({ text: '<' + 'a'.repeat(100000) }).kind !== 'retryable', true);
});

test('nudge: retryable mentions the retry tool and the detected tool', () => {
  const n = nudgeText({ kind: 'retryable', name: 'read_file', args: {} }, 'retry_stray_call');
  assert.match(n, /retry_stray_call/);
  assert.match(n, /read_file/);
  assert.match(n, /mistake/i);
});

test('nudge: shaped explicitly forbids calling the retry tool', () => {
  const n = nudgeText({ kind: 'shaped', reason: "the tool 'x' is not registered" }, 'retry_stray_call');
  assert.match(n, /do NOT call retry_stray_call/);
  assert.match(n, /not registered/);
});

test('nudge: xml-only never mentions the retry tool', () => {
  const n = nudgeText({ kind: 'xml-only' }, 'retry_stray_call');
  assert.doesNotMatch(n, /retry_stray_call/);
  assert.match(n, /mistake/i);
});

test('nudge: none yields empty string', () => {
  assert.equal(nudgeText({ kind: 'none' }, 'retry_stray_call'), '');
});

test('nudges stay within the token budget (roughly < 90 words)', () => {
  for (const v of [
    { kind: 'retryable', name: 'read_file', args: {} },
    { kind: 'shaped', reason: "the tool 'read_file' is not registered" },
    { kind: 'xml-only' },
  ]) {
    const words = nudgeText(v, 'retry_stray_call').split(/\s+/).length;
    assert.ok(words < 90, `nudge too long: ${words} words`);
  }
});

test('default example-skip pattern is a valid regex', () => {
  assert.doesNotThrow(() => new RegExp(DEFAULT_EXAMPLE_SKIP, 'i'));
});
