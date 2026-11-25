// One Durable Object per user (id derived only from the signed-in user id). It holds that user's
// agent WebSocket and relays tool calls to it. It runs no user code and stores no secrets: only the
// agent's advertised tool list, so tools/list still answers while the agent is offline.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.ts';
import { Download, EventFeed, decodeFrame, responseHeaders, type HeadMsg } from './files.ts';

export interface ToolInfo { name: string; title?: string; description?: string; inputSchema: unknown; annotations?: unknown }
type Result = { content: unknown[]; isError?: boolean; [k: string]: unknown };

// Above the hub's 330 s tool timeout (src/cloud.ts) and the 300 s wait cap, so this clean error only shows when the agent is stuck.
export const CALL_TIMEOUT_MS = 360_000;
const MAX_TOOLS = 200;

export class UserHub extends DurableObject<Env> {
  private pending = new Map<string, { resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout> }>();
  private downloads = new Map<string, Download>();
  private feed = new EventFeed();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Called by the Worker after it has verified the agent token for this user. */
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/file/')) return this.file(request, path.slice('/file/'.length));
    if (path === '/events') return this.events();
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    for (const old of this.ctx.getWebSockets('agent')) old.close(4000, 'replaced by a newer agent connection');
    this.ctx.acceptWebSocket(server, ['agent']);
    this.feed.broadcast(); // pages show "agent offline" or the files again
    server.serializeAttachment({ since: Date.now(), tokenId: request.headers.get('x-agent-token-id') });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') { // binary: file data, prefixed with the request id
      const f = decodeFrame(raw);
      if (f) this.downloads.get(f.id)?.onChunk(f.data);
      return;
    }
    let msg: { type?: string; id?: string; result?: Result; tools?: ToolInfo[] } & Partial<HeadMsg>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello' && Array.isArray(msg.tools)) {
      await this.ctx.storage.put('tools', msg.tools.slice(0, MAX_TOOLS));
    } else if (msg.type === 'files-changed') {
      this.feed.broadcast();
    } else if (msg.type === 'file-head' && typeof msg.id === 'string') {
      this.downloads.get(msg.id)?.onHead({ status: Number(msg.status) || 502, headers: msg.headers ?? {}, message: msg.message });
    } else if (msg.type === 'file-end' && typeof msg.id === 'string') {
      this.downloads.get(msg.id)?.onEnd();
    } else if (msg.type === 'file-error' && typeof msg.id === 'string') {
      this.downloads.get(msg.id)?.fail(msg.message ?? 'The download failed.');
    } else if (msg.type === 'result' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.result && Array.isArray(msg.result.content) ? msg.result : { content: [{ type: 'text', text: 'Malformed agent result.' }], isError: true });
    }
  }

  /** Live updates for the signed-in owner's dashboard (the Worker has checked the session). */
  private events(): Response {
    const stream = this.feed.subscribe();
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        this.feed.ping();
        if (!this.feed.size && this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } // nobody listens: let the object sleep
      }, 20_000);
    }
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }

  /** Stream one shared file from the agent to the caller (the Worker has already checked the signed-in owner). */
  private async file(request: Request, shareId: string): Promise<Response> {
    const ws = this.ctx.getWebSockets('agent')[0];
    if (!ws) return new Response('Your agent is offline.', { status: 503 });
    const id = crypto.randomUUID();
    const dl = new Download(id, (m) => { try { ws.send(JSON.stringify(m)); } catch { /* socket gone: webSocketClose fails the download */ } });
    this.downloads.set(id, dl);
    dl.onClosed = () => this.downloads.delete(id);
    const head = request.method === 'HEAD';
    ws.send(JSON.stringify({ type: 'file', id, share: shareId, range: request.headers.get('range') ?? undefined, ifRange: request.headers.get('if-range') ?? undefined, head, inline: request.headers.get('x-inline') === '1' }));
    const h = await dl.head;
    if (h.status >= 400 && h.status !== 416) return new Response(h.message ?? 'Not available.', { status: h.status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    return new Response(head || h.status === 416 ? null : dl.body, { status: h.status, headers: responseHeaders(h.headers) });
  }

  async webSocketClose(ws: WebSocket, code: number) {
    for (const d of this.downloads.values()) d.fail('The agent disconnected.');
    this.feed.broadcast();
    ws.close(code === 1005 ? 1000 : code, 'closed');
  }

  async tools(): Promise<ToolInfo[]> { return (await this.ctx.storage.get<ToolInfo[]>('tools')) ?? []; }

  async status() {
    const ws = this.ctx.getWebSockets('agent')[0];
    const tools = await this.tools();
    return { online: !!ws, since: ws ? (ws.deserializeAttachment() as { since: number }).since : null, tools: tools.length };
  }

  /** Relay one tools/call to the agent; resolves with the agent's CallToolResult. */
  async call(name: string, args: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<Result | null> {
    const ws = this.ctx.getWebSockets('agent')[0];
    if (!ws) return null; // offline: the caller explains how to start the agent
    const id = crypto.randomUUID();
    return new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: timeoutMs === CALL_TIMEOUT_MS ? 'Your orchestrator agent did not answer within 6 minutes.' : 'Your orchestrator agent did not answer in time.' }) }], isError: true });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  /** Revocation: drop the live connection that used a revoked token. */
  async disconnect(tokenId: string) {
    for (const ws of this.ctx.getWebSockets('agent')) {
      if ((ws.deserializeAttachment() as { tokenId?: string }).tokenId === tokenId) ws.close(4001, 'agent token revoked');
    }
  }
}
