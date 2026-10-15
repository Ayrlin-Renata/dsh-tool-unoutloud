import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decode(p) {
  const buf = readFileSync(p);
  const out = [];
  let i = 0;
  for (;;) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    const next = buf.indexOf(MAGIC, at + 4);
    const end = next < 0 ? buf.length : next;
    try { out.push(zstdDecompressSync(buf.subarray(at, end))); } catch {}
    i = end;
  }
  return Buffer.concat(out).toString('utf8');
}
const evs = [];
for (const line of decode(process.argv[2]).split('\n')) {
  if (!line) continue;
  try { evs.push(JSON.parse(line)); } catch {}
}
const textOf = (e) => {
  const c = e.data?.message?.content ?? e.data?.content;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
};
const ts = (e) => new Date(e.time).toISOString().slice(11, 23);

console.log('total events: ' + evs.length);
console.log('--- last 30 events:');
for (const e of evs.slice(-30)) {
  let d = '';
  if (e.type === 'tool/call') d = ' name=' + e.data.name + ' args=' + JSON.stringify(String(e.data.arguments ?? '').slice(0, 80));
  else if (e.type === 'tool/result') d = ' err=' + String(e.data.error ?? false);
  else if (e.type === 'turn/end') d = ' turn=' + e.data.turn + ' reason=' + JSON.stringify(e.data.reason);
  else if (e.type === 'turn/start') d = ' turn=' + e.data.turn;
  else if (e.type === 'assistant/message') d = ' turn=' + e.data.turn + ' step=' + e.data.step + ' blocks=[' + (e.data?.message?.content ?? []).map((b) => b?.type).join(',') + '] text=' + JSON.stringify(textOf(e).slice(0, 140));
  else if (e.type === 'user/message') d = ' source=' + JSON.stringify(e.data.source?.kind ?? e.data.source) + ' text=' + JSON.stringify(textOf(e).slice(0, 100));
  else if (e.type === 'step/start' || e.type === 'step/end') d = ' turn=' + e.data.turn + ' step=' + e.data.step;
  else if (e.type === 'agent/inbox/spliced') d = ' target=' + e.data.target + ' inserted=' + JSON.stringify((e.data.inserted ?? []).map((x) => x?.message?.role ?? x?.kind ?? '?'));
  console.log('  ' + ts(e) + ' #' + e.seq + ' ' + e.type + d);
}
console.log('--- nudge timestamps vs seq 2438:');
for (const e of evs) {
  if (e.type === 'user/message' && e.data?.source?.kind === 'plugin' && e.data?.source?.plugin === 'unoutloud') {
    console.log('  nudge #' + e.seq + ' ' + ts(e) + ' turn_hint=' + JSON.stringify(e.data.turn ?? null));
  }
  if (e.seq === 2438) console.log('  stray #2438 ' + ts(e));
}
console.log('--- all turn/end:');
for (const e of evs.filter((e) => e.type === 'turn/end')) {
  console.log('  ' + ts(e) + ' turn=' + e.data.turn + ' ' + JSON.stringify(e.data.reason));
}
