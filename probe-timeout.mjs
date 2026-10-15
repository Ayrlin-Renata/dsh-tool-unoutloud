import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { detect } from './src/detect.ts';

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
function textOf(e) {
  const c = e.data?.message?.content ?? e.data?.content;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

for (const p of process.argv.slice(2)) {
  console.log('==== ' + p.split(/[\\/]/).slice(-2)[0]);
  const evs = [];
  for (const line of decode(p).split('\n')) {
    if (!line) continue;
    try { evs.push(JSON.parse(line)); } catch {}
  }
  console.log('events: ' + evs.length);
  const idx = [];
  evs.forEach((e, i) => {
    if (e.type !== 'assistant/message') return;
    const t = textOf(e);
    if (!t.includes('structure_probe.mjs')) return;
    idx.push(i);
    const blocks = e.data?.message?.content ?? [];
    console.log(
      'HIT seq=' + e.seq + ' turn=' + e.data.turn + ' step=' + e.data.step +
      ' interrupted=' + String(e.data.interrupted ?? false) +
      ' blocks=[' + blocks.map((b) => b?.type).join(',') + ']' +
      ' hasTimeoutMarker=' + t.includes('marked as invalid') +
      ' textLen=' + t.length,
    );
    console.log('  text: ' + JSON.stringify(t.slice(0, 400)));
  });
  for (const i of idx) {
    console.log('--- after seq ' + evs[i].seq + ':');
    for (let j = i + 1; j < Math.min(i + 12, evs.length); j++) {
      const e = evs[j];
      let d = '';
      if (e.type === 'tool/call') d = ' name=' + e.data.name;
      if (e.type === 'turn/end') d = ' turn=' + e.data.turn + ' reason=' + JSON.stringify(e.data.reason);
      if (e.type === 'assistant/message') d = ' turn=' + e.data.turn + ' blocks=[' + (e.data?.message?.content ?? []).map((b) => b?.type).join(',') + ']';
      if (e.type === 'user/message') d = ' source=' + JSON.stringify(e.data.source?.kind ?? e.data.source);
      console.log('  ' + e.type + ' seq=' + e.seq + d);
    }
  }
  let nudges = 0;
  for (const e of evs) {
    if (e.type === 'user/message' && e.data?.source?.kind === 'plugin' && e.data?.source?.plugin === 'unoutloud') {
      nudges++;
      console.log('NUDGE seq=' + e.seq + ' ' + JSON.stringify(textOf(e).slice(0, 100)));
    }
  }
  console.log('nudges: ' + nudges);
  for (const e of evs.filter((e) => e.type === 'turn/end').slice(-4)) {
    console.log('TURN-END turn=' + e.data.turn + ' reason=' + JSON.stringify(e.data.reason));
  }
  // Replay detect on each hit with its real last-user text.
  const users = evs.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user');
  const lastUser = users.length ? textOf(users[users.length - 1]) : '';
  for (const i of idx) {
    const t = textOf(evs[i]);
    console.log(
      'DETECT seq=' + evs[i].seq +
      ' plain=' + JSON.stringify(detect({ text: t })) +
      ' withUser(' + lastUser.length + 'ch)=' + JSON.stringify(detect({ text: t, lastUserText: lastUser })),
    );
  }
}
