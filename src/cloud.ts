// Agent mode: dial out to the hosted front door and serve its tool calls with the local tools.
// Nothing listens publicly; the cloud can only call the same tools a local MCP client could.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileTransfers, setFilesListener } from './tools/files.ts';
import type { Ctx } from './tools/common.ts';

/**
 * How long the hub waits for a forwarded tool call. The SDK default is 60 s, which cut session_send short
 * with "MCP error -32001: Request timed out". Staggered above the 300 s wait cap (MAX_WAIT_S) and below the
 * worker's 360 s, so the tool's own wait is always the real limit. No resetTimeoutOnProgress: tools send no progress.
 */
export const TOOL_TIMEOUT_MS = 330_000;

export const forwardCall = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });

/** Link health timings; tests shrink them. */
export interface LinkOpts {
  pingMs: number;       // how often to ping the worker
  staleMs: number;      // no pong for this long = dead link, reconnect
  retryMs: number;      // first reconnect delay; doubles up to maxRetryMs (with jitter)
  maxRetryMs: number;
  closeGraceMs: number; // a dead link's close handshake may never finish: abandon the socket after this
  makeSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}
const LINK: LinkOpts = { pingMs: 30_000, staleMs: 75_000, retryMs: 1000, maxRetryMs: 60_000, closeGraceMs: 5_000 };

const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

export async function connectCloud(makeServer: () => McpServer, url: string, token: string, ctx?: Ctx, opts: Partial<LinkOpts> = {}) {
  const L = { ...LINK, ...opts };
  const u = new URL(url);
  // The token must never travel in clear text: plain ws:// only for a local test server.
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
    throw new Error('ORCH_CLOUD_URL must be wss:// (ws:// only for localhost)');
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await makeServer().connect(serverSide);
  const client = new Client({ name: 'cloud-relay', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();

  let delay = L.retryMs;
  let current: WebSocket | undefined;
  let stopped = false;
  let stopTimers = () => {};
  const open = () => {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = L.makeSocket ? L.makeSocket(url, { authorization: `Bearer ${token}` }) : new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
    } catch (e) { // no network stack right now: back off and try again
      console.error(`cloud: could not open the link (${(e as Error).message}); retrying in ${delay / 1000}s`);
      setTimeout(open, jitter(delay)); delay = Math.min(delay * 2, L.maxRetryMs);
      return;
    }
    current = ws;
    let lastPong = Date.now();
    let retried = false; // one retry per socket, whether onclose fires or the grace timer abandons it
    const safeSend = (d: string) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(d); } catch { /* closing: the retry path takes over */ } };
    const transfers = ctx ? new FileTransfers(ctx, { send: (d) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(d); } catch { /* closing */ } } }) : undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    stopTimers = () => { clearInterval(timer); ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; };
    ws.onopen = () => {
      delay = L.retryMs;
      lastPong = Date.now();
      safeSend(JSON.stringify({ type: 'hello', tools }));
      setFilesListener(() => safeSend(JSON.stringify({ type: 'files-changed' })));
      timer = setInterval(() => {
        if (Date.now() - lastPong > L.staleMs) { // dead link (network dropped, no close frame): reconnect now
          console.error('cloud: no pong from the worker; reconnecting');
          try { ws.close(); } catch { /* already closed */ }
          // A half-open socket never completes its close handshake, so onclose may not come: abandon it ourselves.
          setTimeout(() => retry({ code: 1006, reason: 'stale' }), L.closeGraceMs);
          clearInterval(timer);
          return;
        }
        safeSend('ping');
      }, L.pingMs);
      console.log(`cloud: connected to ${u.host}, ${tools.length} tools advertised`);
    };
    ws.onmessage = async (ev) => {
      const data = String(ev.data);
      if (data === 'pong') { lastPong = Date.now(); return; }
      let msg: { type?: string; id?: string; name?: string; args?: Record<string, unknown> };
      try { msg = JSON.parse(data); } catch { return; }
      if (transfers?.handles(msg.type)) return void transfers.onMessage(msg as never);
      if (msg.type !== 'call' || typeof msg.id !== 'string' || typeof msg.name !== 'string') return;
      let result;
      try {
        result = await forwardCall(client, msg.name, msg.args ?? {});
      } catch (e) {
        result = { content: [{ type: 'text', text: JSON.stringify({ summary: `Tool failed: ${(e as Error).message}` }) }], isError: true };
      }
      // Answer on the live socket only: if this one died meanwhile, the worker already told the caller to retry.
      safeSend(JSON.stringify({ type: 'result', id: msg.id, result }));
    };
    const retry = (ev: { code: number; reason?: string }) => {
      if (retried || stopped) return;
      retried = true;
      clearInterval(timer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; // a late event from an abandoned socket must not act
      try { ws.close(); } catch { /* gone */ }
      transfers?.closeAll();
      if (current === ws) setFilesListener(null);
      if (ev.code === 4001) return console.error('cloud: agent token revoked; not reconnecting. Create a new token in the dashboard.');
      if (ev.code === 4000) return console.error('cloud: another agent connected with this account; this one stops.');
      console.error(`cloud: disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}); retrying in ${delay / 1000}s`);
      setTimeout(open, jitter(delay));
      delay = Math.min(delay * 2, L.maxRetryMs);
    };
    ws.onclose = retry;
    ws.onerror = () => {}; // onclose follows and handles the retry
  };
  open();
  /** Stop reconnecting and drop the live link (tests; the agent process just exits). */
  return () => { stopped = true; stopTimers(); try { current?.close(); } catch { /* gone */ } };
}
