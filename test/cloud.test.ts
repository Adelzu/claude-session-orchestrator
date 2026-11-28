import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectCloud } from '../src/cloud.ts';

/** A scriptable WebSocket: nothing happens unless the test says so (like a half-open TCP link). */
class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0; sent: string[] = []; closedByUs = 0;
  onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => unknown) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor() { FakeWs.all.push(this); }
  send(d: string) { if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close()."); this.sent.push(d); }
  close() { this.closedByUs++; /* a dead link: the closing handshake never finishes, onclose never fires */ }
  open() { this.readyState = 1; this.onopen?.(); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(5); } };
const fast = { pingMs: 15, staleMs: 60, retryMs: 10, maxRetryMs: 40, closeGraceMs: 20 };
let stop = () => {};
afterEach(() => stop());
const start = async (pong: boolean | 'after-first') => {
  FakeWs.all = [];
  const server = new McpServer({ name: 't', version: '1' });
  server.registerTool('echo', { description: 'e', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  stop = await connectCloud(() => server, 'ws://localhost:1/agent', 'tok', undefined, { ...fast, makeSocket: () => {
    const ws = new FakeWs();
    if (pong === true || (pong === 'after-first' && FakeWs.all.length > 1)) { const send = ws.send.bind(ws); ws.send = (d) => { send(d); if (d === 'ping') queueMicrotask(() => ws.onmessage?.({ data: 'pong' })); }; }
    return ws as never;
  } });
  return FakeWs.all;
};

test('cloud: a link that goes silent (no close frame) is abandoned and re-dialled without a restart', async () => {
  const all = await start('after-first');
  all[0]!.open();
  assert.match(all[0]!.sent[0]!, /"type":"hello"/);
  await until(() => all.length === 2); // stale -> close() never completes -> grace timer -> new socket
  assert.ok(all[0]!.closedByUs >= 1);
  all[1]!.open();
  assert.match(all[1]!.sent[0]!, /"type":"hello"/, 'the new link re-advertises the tools');
  all[0]!.drop(); // a late close from the abandoned socket must not spawn a third one
  await sleep(120);
  assert.equal(all.length, 2);
});

test('cloud: a healthy link (pongs arrive) is left alone', async () => {
  const all = await start(true);
  all[0]!.open();
  await sleep(250);
  assert.equal(all.length, 1);
  assert.ok(all[0]!.sent.filter((x) => x === 'ping').length >= 3);
});

test('cloud: network drop (close 1006) reconnects with backoff; a revoked token (4001) does not', async () => {
  const all = await start(true);
  all[0]!.drop();
  await until(() => all.length === 2);
  all[1]!.drop();
  await until(() => all.length === 3);
  all[2]!.drop(4001);
  await sleep(150);
  assert.equal(all.length, 3);
});

test('cloud: answering a call on a socket that closed meanwhile does not throw or crash', async () => {
  const all = await start(true);
  all[0]!.open();
  const p = all[0]!.onmessage!({ data: JSON.stringify({ type: 'call', id: 'x', name: 'echo', args: {} }) });
  all[0]!.readyState = 2; // closing while the tool runs
  await p; // would reject with "send() after close()" before the fix
  assert.ok(!all[0]!.sent.some((m) => m.includes('"result"')));
});
