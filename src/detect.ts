/**
 * unoutloud — pure detection engine.
 *
 * Decides what an assistant reply is when a turn is about to close:
 *
 * - `none`      a normal reply; leave the turn alone.
 * - `retryable` the reply contains a tool call written as plain text, the call
 *               parses (possibly after lenient fixes), and the target tool is
 *               registered — offer `retry_stray_call`.
 * - `shaped`    the reply looks like a tool call but cannot be retried (bad
 *               JSON, no tool name, tool not registered, …) — nudge with the
 *               reason and explicitly tell the model not to call the retry tool.
 * - `xml-only`  the reply is raw XML/markup with no readable prose.
 *
 * Zero runtime imports on purpose: this file loads under plain `node --test`
 * (type stripping) for the fixture suite and under the harness plugin loader
 * in production alike.
 */

/** Verdict of the detection engine. */
export type Verdict =
  | { kind: 'none' }
  | {
      kind: 'retryable';
      /** Tool name parsed from the stray call. */
      name: string;
      /** Parsed (and normalized) arguments for the stray call. */
      args: Record<string, unknown>;
      /**
       * How many times this exact call (same tool + same parsed arguments)
       * appears in the reply. Models that hit an invalid/timed-out tool call
       * often re-emit the identical call in the same reply, so a retry must
       * send it exactly once — never one dispatch per copy.
       */
      identicalCopies?: number;
    }
  | { kind: 'shaped'; reason: string }
  | { kind: 'xml-only' };

/** Text-only view of the input the plugin hands to the detector. */
export interface DetectInput {
  /** The final assistant reply (text blocks joined). */
  text: string;
  /** The `assistant/message` event carried `interrupted: true`. */
  interrupted?: boolean;
  /** The latest direct-user prompt, for the example-skip guard. */
  lastUserText?: string;
}

/** Detector configuration; every field has a default. */
export interface DetectOptions {
  /**
   * Regex sources marking "this is where a stray call starts". Case-insensitive.
   * Detection only — parsing uses dedicated shapes, a custom pattern that does
   * not parse degrades to `shaped` (nudge without retry).
   */
  patterns?: string[];
  /** Regex source tested against the head+tail edges of the last direct-user
   * prompt (a long paste cannot disable detection by quoting an example word
   * mid-text). Empty string disables. */
  exampleSkipRegex?: string | null;
  /** Minimum tag-character ratio for the `xml-only` verdict. Default 0.6. */
  xmlDominance?: number;
  /**
   * A stray match starting after this many lead-in characters is ignored unless
   * the call region itself dominates the reply — protects prose-with-example
   * replies from false nudges. Default 400.
   */
  leadInMaxChars?: number;
  /** Registry check; default assumes every name is registered (used by tests). */
  isToolRegistered?: (name: string) => boolean;
}

/** Default stray-call indicators (regex sources, matched case-insensitively). */
export const DEFAULT_PATTERNS: string[] = [
  '<(?:[\\w.:-]+:)?invoke\\b',
  '<(?:[\\w.:-]+:)?function_calls\\b',
  '<(?:[\\w.:-]+:)?tool_?calls?\\b',
  '<(?:[\\w.:-]+:)?tool_use\\b',
  '\\{\\s*"type"\\s*:\\s*"tool_use"',
  '\\{\\s*"name"\\s*:\\s*"[^"]*"\\s*,\\s*"(?:arguments|args|parameters|input)"',
];

/**
 * Default example-skip guard, tested against the edges of the last
 * direct-user prompt: when the human asked for an example / a demonstration /
 * a made-up snippet, an XML-shaped reply is intentional. Empty string disables
 * the guard.
 */
export const DEFAULT_EXAMPLE_SKIP =
  '(?:for example|for instance|example of|as an example|show me an? example|demonstrat|illustrat|pretend|make up)';

/**
 * Chars of each prompt edge tested by the example-skip guard. Asks live at the
 * head ("show me an example…") or the tail (context paste, then the ask); a
 * skip-word buried mid-paste in a multi-KB quoted document is incidental and
 * must not disable detection for the turn.
 */
export const EXAMPLE_SKIP_EDGE = 300;

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2f;': '/',
  '&#47;': '/',
  '&amp;': '&',
};

/** Single-pass decode of the XML entities models escape stray calls with. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:lt|gt|quot|amp|#39|#x27|#x2f|#47);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Lenient JSON parse: strict → trailing-comma removal → single-quote keys
 * (only when the payload has no double quotes), each optionally combined.
 */
function looseJson(raw: string): unknown {
  const s = raw.trim();
  const candidates: string[] = [s];
  const noTrail = s.replace(/,\s*([}\]])/g, '$1');
  if (noTrail !== s) candidates.push(noTrail);
  if (!s.includes('"') && s.includes("'")) {
    candidates.push(s.replace(/'/g, '"'));
    const both = noTrail.replace(/'/g, '"');
    if (both !== noTrail) candidates.push(both);
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fraction of `s` covered by markup tags (open/close/self-closing/doctype). */
function tagRatio(s: string): number {
  if (s.length === 0) return 0;
  const tagRe = /<[A-Za-z!/?][^<>]*>/g;
  let tagLen = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s)) !== null) tagLen += m[0].length;
  return tagLen / s.length;
}

/** Canonical JSON (recursively key-sorted) to compare two parsed arg sets. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

/** Slice one balanced JSON object starting at `from`; falls back to the last `}`. */
function sliceJson(s: string, from: number): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  const lastBrace = s.lastIndexOf('}');
  return lastBrace > from ? s.slice(from, lastBrace + 1) : s.slice(from);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Slice one XML element starting at `from`: the element through its matching
 * close tag, or — when the call was cut off mid-flight — to the end of text.
 */
function sliceXml(s: string, from: number): string {
  const openRe = /<\s*([A-Za-z_][\w.:-]*)/y;
  openRe.lastIndex = from;
  const om = openRe.exec(s);
  if (!om) return s.slice(from);
  const tag = om[1];
  const gt = s.indexOf('>', om.index);
  if (gt < 0) return s.slice(from); // no `>` at all: element starts but never closes
  if (s[gt - 1] === '/') return s.slice(from, gt + 1); // self-closing
  // 'g' is required: without it, lastIndex is ignored and exec always searches
  // from index 0 — for a duplicated call that finds the FIRST copy's close tag
  // (before `from`), yielding an empty/wrong region for the second copy.
  const closeRe = new RegExp(`</\\s*${escapeRe(tag)}\\s*>`, 'gi');
  closeRe.lastIndex = gt + 1;
  const cm = closeRe.exec(s);
  if (cm) return s.slice(from, cm.index + cm[0].length);
  return s.slice(from); // unterminated: the stray call runs to the end of the reply
}

/** Extract a stray tool name from parsed JSON call shapes. */
function callFromJson(obj: Record<string, unknown>): { name?: string; args?: Record<string, unknown>; reason?: string } {
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return { reason: 'the call JSON has no tool name' };
  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input;
  if (rawArgs === undefined) return { reason: 'the call JSON has no arguments field' };
  let args: unknown = rawArgs;
  if (typeof rawArgs === 'string') {
    args = looseJson(decodeEntities(rawArgs));
    if (args === undefined) return { reason: 'the arguments are not valid JSON' };
  }
  if (!isPlainObject(args)) return { reason: 'the arguments are not a JSON object' };
  return { name, args };
}

/** Convert one parameter body: JSON structures and primitives, else string. */
function parameterValue(raw: string): unknown {
  const v = decodeEntities(raw).trim();
  if (v.startsWith('{') || v.startsWith('[')) {
    const parsed = looseJson(v);
    if (parsed !== undefined) return parsed;
    return v;
  }
  if (/^(?:-?\d+(?:\.\d+)?|true|false|null)$/.test(v)) {
    const parsed = looseJson(v);
    if (parsed !== undefined) return parsed;
  }
  return v;
}

type ParseResult = { name: string; args: Record<string, unknown> } | { reason: string };

/** Parse an XML-shaped stray call (`<invoke>`, `<tool_use>`, `<function_calls>`…). */
function parseXmlCall(region: string): ParseResult {
  const headRe = /^<\s*([A-Za-z_][\w.:-]*)(\s[^>]*?)?(\/?)>/;
  const hm = headRe.exec(region);
  if (!hm) return { reason: 'the call element could not be read' };
  const tag = hm[1].toLowerCase().split(':').pop() ?? '';
  const attrs = hm[2] ?? '';
  const selfClosing = hm[3] === '/';

  // Wrapper blocks recurse into their first `<invoke>` element.
  if (tag === 'function_calls' || tag === 'tool_calls' || tag === 'tools') {
    const inner = region.slice(hm[0].length);
    const im = /<\s*(?:[\w.:-]+:)?invoke\b/i.exec(inner);
    if (!im) return { reason: `the <${tag}> block contains no invoke call` };
    return parseXmlCall(sliceXml(inner, im.index));
  }

  if (tag !== 'invoke' && tag !== 'tool_use' && tag !== 'tool_call' && tag !== 'call') {
    return { reason: `<${tag}> is not a tool-call element` };
  }

  let body = selfClosing ? '' : region.slice(hm[0].length);
  if (!selfClosing) body = body.replace(new RegExp(`</\\s*${escapeRe(tag)}\\s*>\\s*$`, 'i'), '');

  const nameMatch = /(?:^|\s)name\s*=\s*["']([^"']+)["']/.exec(attrs);
  const argsMatch = /(?:^|\s)(?:arguments|args|input)\s*=\s*(["'])([\s\S]*?)(?:\1)(?=[\s/>])/.exec(attrs);

  // Arguments from an attribute: arguments="{...}" / input='{...}'.
  if (argsMatch) {
    const parsed = looseJson(decodeEntities(argsMatch[2]));
    if (!isPlainObject(parsed)) return { reason: 'the arguments attribute is not a JSON object' };
    if (nameMatch) return { name: nameMatch[1].trim(), args: parsed };
    // No name attribute: maybe the attribute value itself is a full call JSON.
    const inner = callFromJson(parsed);
    if (inner.name && inner.args) return { name: inner.name, args: inner.args };
    return { reason: 'the call element has no name attribute' };
  }

  const trimmedBody = body.trim();
  if (trimmedBody === '') {
    if (nameMatch) return { name: nameMatch[1].trim(), args: {} };
    return { reason: 'the call element has no name attribute' };
  }

  // Arguments as a JSON object in the body: invoke element wrapping `{...}`.
  if (trimmedBody.startsWith('{')) {
    const parsed = looseJson(trimmedBody);
    if (!isPlainObject(parsed)) return { reason: 'the arguments are not valid JSON' };
    if (nameMatch) return { name: nameMatch[1].trim(), args: parsed };
    const inner = callFromJson(parsed);
    if (inner.name && inner.args) return { name: inner.name, args: inner.args };
    if (inner.reason) return { reason: inner.reason };
    return { reason: 'the call element has no name attribute' };
  }

  // Arguments as parameter entries: `<parameter name="k">v` … closing tag.
  const paramRe = /<\s*([A-Za-z_][\w.:-]*)\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\s*\1\s*>/gi;
  const args: Record<string, unknown> = {};
  let rest = body;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = paramRe.exec(body)) !== null) {
    args[match[2]] = parameterValue(match[3]);
    count++;
    rest = rest.replace(match[0], '');
  }
  if (count === 0) return { reason: 'the arguments are neither JSON nor parameter entries' };
  if (rest.replace(/<\/?[A-Za-z_][\w.:-]*(?:\s[^>]*)?>/g, ' ').trim() !== '') {
    return { reason: 'the call has text outside its parameter entries' };
  }
  if (!nameMatch) return { reason: 'the call element has no name attribute' };
  return { name: nameMatch[1].trim(), args };
}

/** Parse a region that starts at a stray-call indicator (`{` or `<`). */
function parseCallRegion(region: string, depth = 0): ParseResult {
  const t = region.trimStart();
  if (t.startsWith('{')) {
    const parsed = looseJson(t);
    if (!isPlainObject(parsed)) return { reason: 'the call JSON is not parseable' };
    // callFromJson returns a loose shape (name/args XOR reason); narrow it to ParseResult.
    const inner = callFromJson(parsed);
    if (inner.name && inner.args) return { name: inner.name, args: inner.args };
    return { reason: inner.reason ?? 'the call JSON is not a recognizable call' };
  }
  if (t.startsWith('<')) return parseXmlCall(t);
  if (depth < 2) {
    const next = t.search(/[{<]/);
    if (next >= 0 && next < 80) return parseCallRegion(t.slice(next), depth + 1);
  }
  return { reason: 'the stray text is not a recognizable call shape' };
}

/** Index ranges covered by markdown fences, unclosed fence runs to the end. */
function fenceRanges(s: string): Array<[number, number]> {
  const starts: number[] = [];
  const re = /```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) starts.push(m.index);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i + 1 < starts.length; i += 2) ranges.push([starts[i], starts[i + 1] + 3]);
  if (starts.length % 2 === 1) ranges.push([starts[starts.length - 1], s.length]);
  return ranges;
}

function stripFences(s: string): string {
  let out = s;
  for (const [a, b] of fenceRanges(s)) out = out.slice(0, a) + out.slice(b);
  return out;
}

interface Match {
  index: number;
  length: number;
}

/**
 * Main entry: verdict for one assistant reply at its turn-stopping boundary.
 * Pure and total — never throws on malformed input.
 */
export function detect(input: DetectInput, options: DetectOptions = {}): Verdict {
  try {
    if (input?.interrupted) return { kind: 'none' };
    const original = typeof input?.text === 'string' ? input.text : '';
    if (original.trim() === '') return { kind: 'none' };

    // Example-skip guard: the human asked for an example, so XML-shaped output
    // is intentional. Applied before anything else — but only against the
    // edges of the prompt (see EXAMPLE_SKIP_EDGE): a "For example" quoted at
    // index 21k of a 46KB advice paste is not a request for an example.
    const skipSrc = options.exampleSkipRegex ?? DEFAULT_EXAMPLE_SKIP;
    if (skipSrc && input.lastUserText) {
      try {
        const prompt = input.lastUserText;
        const skipText =
          prompt.length > EXAMPLE_SKIP_EDGE * 2
            ? prompt.slice(0, EXAMPLE_SKIP_EDGE) + ' ' + prompt.slice(-EXAMPLE_SKIP_EDGE)
            : prompt;
        if (new RegExp(skipSrc, 'i').test(skipText)) return { kind: 'none' };
      } catch {
        /* invalid user pattern: ignore the guard */
      }
    }

    // Decode XML entities once; a fully escaped stray call only exists here.
    const text = decodeEntities(original);

    // Locate stray-call indicators.
    const patternSources = options.patterns ?? DEFAULT_PATTERNS;
    const raw: Match[] = [];
    for (const src of patternSources) {
      let re: RegExp;
      try {
        re = new RegExp(src, 'gi');
      } catch {
        continue; // invalid user pattern: skip it
      }
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        raw.push({ index: m.index, length: m[0].length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    raw.sort((a, b) => a.index - b.index || b.length - a.length);
    const deduped: Match[] = [];
    let lastEnd = -1;
    for (const m of raw) {
      if (m.index >= lastEnd) {
        deduped.push(m);
        lastEnd = m.index + m.length;
      }
    }

    const fences = fenceRanges(text);
    const inFence = (at: number): boolean => fences.some(([a, b]) => at >= a && at < b);

    let candidates: Match[] = deduped.filter((m) => !inFence(m.index));
    if (candidates.length === 0 && deduped.length > 0) {
      // Every indicator sits inside a fence: an all-fence reply still stalls the
      // chat, but a fence buried in prose is a deliberate example.
      const prose = stripFences(text).trim();
      if (prose.length <= 100) candidates = deduped;
    }

    const dominance = options.xmlDominance ?? 0.6;
    const leadInMax = options.leadInMaxChars ?? 400;
    const registered = options.isToolRegistered ?? (() => true);

    const parseReasons: string[] = [];
    const unregisteredReasons: string[] = [];
    for (const c of candidates) {
      const prefixLen = text.slice(0, c.index).trim().length;
      const end =
        text[c.index] === '{'
          ? c.index + sliceJson(text, c.index).length
          : c.index + sliceXml(text, c.index).length;
      const region = text.slice(c.index, end);
      // Prose example: a long lead-in AND a region that does not dominate the
      // reply means the call is being shown, not made.
      if (prefixLen > leadInMax && region.length < dominance * text.length) continue;
      const parsed = parseCallRegion(region);
      if ('name' in parsed) {
        if (registered(parsed.name)) {
          // Count every other candidate that parses to this same call: replies
          // that hit an invalid/timed-out tool call re-emit the identical call
          // in the same reply, and a retry must dispatch it exactly once.
          // Candidates INSIDE this call's own region (e.g. the inner invoke of
          // a function_calls wrapper) are the same single call, not copies.
          let identicalCopies = 1;
          for (const other of candidates) {
            if (other.index >= end) {
              const otherEnd =
                text[other.index] === '{'
                  ? other.index + sliceJson(text, other.index).length
                  : other.index + sliceXml(text, other.index).length;
              const otherParsed = parseCallRegion(text.slice(other.index, otherEnd));
              if (
                'name' in otherParsed &&
                otherParsed.name === parsed.name &&
                stableJson(otherParsed.args) === stableJson(parsed.args)
              ) {
                identicalCopies += 1;
              }
            }
          }
          return { kind: 'retryable', name: parsed.name, args: parsed.args, identicalCopies };
        }
        unregisteredReasons.push(`the tool '${parsed.name}' is not registered`);
      } else {
        parseReasons.push(parsed.reason);
      }
    }
    if (unregisteredReasons.length > 0) return { kind: 'shaped', reason: unregisteredReasons[0] };
    if (parseReasons.length > 0) return { kind: 'shaped', reason: parseReasons[0] };

    // No (surviving) call: is the reply raw XML markup — or does it END with
    // the closing-tag tail of a stray call whose opening was never emitted?
    const trimmed = text.trim();
    if (trimmed.startsWith('<')) {
      if (trimmed.length > 0 && tagRatio(trimmed) >= dominance) return { kind: 'xml-only' };
    } else if (deduped.length === 0) {
      // Orphan tail: no stray-call opening appears ANYWHERE in the reply (a
      // complete inline example elsewhere makes the tail part of that example,
      // already judged by the lead-in guard above).
      const tailMatch = trimmed.match(/(?:<\/[A-Za-z_][\w.:-]*>[\s\S]*)$/);
      if (tailMatch && tagRatio(tailMatch[0]) >= dominance) {
        return {
          kind: 'shaped',
          reason:
            'the reply ends with the closing tags of a stray tool call, but the call itself was never emitted',
        };
      }
    }
    return { kind: 'none' };
  } catch {
    // The detector is total: any internal error degrades to "leave the turn alone".
    return { kind: 'none' };
  }
}
