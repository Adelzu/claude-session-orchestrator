import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentLink, OFFLINE, type Sock } from '../src/link.ts';

/** A fake agent socket: records frames; `echo` answers calls through `link`; send() throws like a closed Cloudflare socket. */
class Fake implements Sock {
  readyState = 1;
  sent: { type: string; id: string; name: string }[] = [];
  name: string; since: number; link?: AgentLink;
  constructor(name: string, since: number, link?: AgentLink) { this.name = name; this.since = since; this.link = link; }
  send(d: string) {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    const m = JSON.parse(d);
    this.sent.push(m);
    if (this.link) queueMicrotask(() => this.link!.result(m.id, { content: [{ type: 'text', text: `from ${this.name}` }] }));
  }
}
const setup = (...mk: ((l: AgentLink) => Fake)[]) => {
  const socks: Fake[] = [];
  const link = new AgentLink(() => socks, (s) => (s as Fake).since);
  for (const f of mk) socks.push(f(link));
  return { socks, link };
};
const textOf = (r: { content: unknown[] } | null) => (r?.content[0] as { text: string }).text;

test('link: the newest live socket gets the call, even when the old one is listed first', async () => {
  const { socks, link } = setup((l) => new Fake('old', 1, l), (l) => new Fake('new', 2, l));
  assert.match(textOf(await link.call('t', {}, 1000, 2000)), /from new/);
  assert.equal(socks[0]!.sent.length, 0);
});

test('link: a closed socket is never used; one that throws is skipped for the next live one', async () => {
  const { socks, link } = setup((l) => new Fake('old', 1, l), (l) => new Fake('dead', 2, l));
  socks[1]!.readyState = 3; // closed but still listed (network drop before the close event)
  assert.match(textOf(await link.call('t', {}, 1000, 2000)), /from old/);
  socks[1]!.readyState = 1; // claims open but send() throws
  socks[1]!.send = () => { throw new TypeError("Can't call WebSocket send() after close()."); };
  assert.match(textOf(await link.call('t', {}, 1000, 2000)), /from old/);
});

test('link: nothing live gives a clear offline error, not a throw; never connected gives null', async () => {
  const { socks, link } = setup((l) => new Fake('a', 1, l));
  socks[0]!.readyState = 3;
  const r = await link.call('t', {}, 1000, 2000);
  assert.equal(r!.isError, true);
  assert.equal(JSON.parse(textOf(r)).summary, OFFLINE);
  assert.match(OFFLINE, /offline.*Retry/);
  socks.length = 0;
  assert.equal(await link.call('t', {}, 1000, 2000), null);
});

test('link: calls waiting on a socket that closes fail at once with a retry message', async () => {
  const { socks, link } = setup(() => new Fake('a', 1)); // never answers
  const p = link.call('t', {}, 60_000, 120_000);
  link.closed(socks[0]!);
  const r = await p;
  assert.equal(r!.isError, true);
  assert.match(textOf(r), /dropped.*Retry/);
});

test('link: socket replaced while an MCP session is open: the same client keeps working on the new socket', async () => {
  const { socks, link } = setup((l) => new Fake('old', 1, l));
  // The worker's MCP server as in index.ts: one session, every tools/call resolves the socket at call time.
  const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' as const } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await link.call(req.params.name, req.params.arguments ?? {}, 1000, 2000) ?? { content: [{ type: 'text', text: 'setup' }], isError: true }) as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '1' });
  await client.connect(b); // the one connector session; never reconnected below

  const text = async () => ((await client.callTool({ name: 't', arguments: {} })).content as { text: string }[])[0]!.text;
  assert.equal(await text(), 'from old');
  // The home internet drops: the old socket dies (no clean close yet), then the hub reconnects on a new socket.
  socks[0]!.readyState = 3;
  const offline = await client.callTool({ name: 't', arguments: {} });
  assert.equal(offline.isError, true);
  assert.match((offline.content as { text: string }[])[0]!.text, /offline/i, 'a clear error, not "send() after close()"');
  socks.push(new Fake('new', 2, link));
  assert.equal(await text(), 'from new', 'same MCP session, newest socket');
  // And with the dead old socket still listed ahead of it:
  assert.equal(socks[0]!.readyState, 3);
  assert.equal(await text(), 'from new');
  await client.close();
});
