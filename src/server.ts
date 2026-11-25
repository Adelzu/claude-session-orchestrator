import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { accessJwtOk, filesTokenOk, machineTokenOk, tokenOk } from './auth.ts';
import { callerFor, ensureSessionMcp } from './session-mcp.ts';
import { connectCloud } from './cloud.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import type { Ctx } from './tools/common.ts';
import * as events from './tools/events.ts';
import * as files from './tools/files.ts';
import * as sessionBrain from './tools/session-brain.ts';
import type { Caller } from './tools/files.ts';
import * as llm from './tools/llm.ts';
import * as machines from './tools/machines.ts';
import * as memory from './tools/memory.ts';
import * as sessions from './tools/sessions.ts';

/** Same text as the hosted worker's (worker/src/index.ts); a unit test keeps them equal. */
export const BRAIN_RULE = "Keep the shared brain current without being asked: as work happens, append decisions, verified results and status changes (a few lines each) to projects/<project>/notes.md with memory_append, and check memory_search before repeating work.";
export const SERVER_INSTRUCTIONS = "Manages the user's Claude Code sessions on their own machines. In voice mode, call events_pending first. Every tool result starts with a one-sentence summary to read out. " + BRAIN_RULE + " " + sessions.LONG_WORK_HINT;

export function mcpServer(ctx: Ctx) {
  const server = new McpServer({ name: 'session-orchestrator', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });
  for (const mod of [machines, sessions, events, files, memory, llm]) mod.register(server, ctx);
  return server;
}

/** What Claude Code sessions on the hub get: the file tools only, no session control. */
export const FILES_INSTRUCTIONS = "Share files from this machine to the user's dashboard Files page with file_share (absolute path, optional ttl_minutes, group and label), file_list and file_revoke. Only files inside the folders the hub allows can be shared; dotfiles are refused. The user opens them signed in on the dashboard; nothing is stored in the cloud. " +
  "Keep the shared brain current without being asked: as you work, append decisions, verified results and status changes (a few lines each) with memory_append (it adds to this project's notes.md), and use memory_search or memory_read to check what is already known. You can read, search and append only, inside your own project's folder.";
export function filesServer(ctx: Ctx, caller: Caller | null = null) {
  const server = new McpServer({ name: 'orchestrator-files', version: '1.0.0' }, { instructions: FILES_INSTRUCTIONS });
  files.register(server, ctx, caller);
  sessionBrain.register(server, ctx, caller);
  return server;
}

export async function boot() {
  const ctx = { cfg: loadConfig(), db: new Db() };
  await memory.ensureBrain();
  ctx.db.failOrphanJobs();
  return ctx;
}

async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

export function app(ctx: Ctx, eventsToken = process.env.EVENTS_TOKEN, mcpToken = process.env.MCP_TOKEN) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/mcp' || url.pathname === '/mcp-files') {
        if (req.method !== 'POST') return void res.writeHead(405).end();
        // Every caller needs a credential: MCP_TOKEN (Claude Code, scripts) or a valid Cloudflare
        // Access JWT (the Claude app via the tunnel). Network address is never trusted.
        // /mcp-files (the sessions' file tools only) takes its own derived token, which does not open /mcp.
        const ok = url.pathname === '/mcp' ? tokenOk(req, mcpToken) || (await accessJwtOk(req)) : filesTokenOk(req, mcpToken);
        if (!ok) return void res.writeHead(401).end();
        // Stateless: a fresh server + transport per request; all state lives in SQLite.
        const server = url.pathname === '/mcp' ? mcpServer(ctx) : filesServer(ctx, await callerFor(ctx, [req.headers['x-orch-pane']].flat()[0]));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, await readJson(req));
      } else if (url.pathname === '/events' && req.method === 'POST') {
        // The per-machine token authenticates the machine; ingest only touches that machine's sessions.
        const machine = url.searchParams.get('machine') ?? '';
        if (!machineTokenOk(req, eventsToken, machine)) return void res.writeHead(401).end();
        const code = events.ingest(ctx, url.searchParams.get('session') ?? '', machine, await readJson(req));
        res.writeHead(code).end();
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(e instanceof SyntaxError ? 400 : 500).end();
      console.error(e);
    }
  });
}

export async function main() {
  const ctx = await boot();
  if (!process.env.EVENTS_TOKEN) console.warn('EVENTS_TOKEN is not set: /events will reject every hook.');
  if (!process.env.MCP_TOKEN && !process.env.CF_ACCESS_AUD) console.warn('Neither MCP_TOKEN nor CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD is set: /mcp will reject every request.');
  // HOST may list several addresses, e.g. 127.0.0.1,<tailscale-ip>: local clients and other machines' hooks.
  // One http.Server per address: a single server can only listen on one.
  const port = Number(process.env.PORT ?? 8787);
  for (const host of (process.env.HOST ?? '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean)) {
    app(ctx).listen(port, host, () => console.log(`session-orchestrator on http://${host}:${port}/mcp`));
  }
  // Give every Claude Code session on this machine the file tools (user-scope MCP entry), without manual setup.
  if (process.env.MCP_TOKEN) void ensureSessionMcp(ctx.cfg, { mcpToken: process.env.MCP_TOKEN, port }).catch((e) => console.error('session file tools:', (e as Error).message));
  // Agent mode for the hosted service: dial out and serve tool calls for the signed-in owner.
  if (process.env.ORCH_CLOUD_URL && process.env.ORCH_AGENT_TOKEN) {
    await connectCloud(() => mcpServer(ctx), process.env.ORCH_CLOUD_URL, process.env.ORCH_AGENT_TOKEN, ctx);
  }
}

if (import.meta.main) await main();
