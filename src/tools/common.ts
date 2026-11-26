import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { UserError, type Config } from '../config.ts';
import type { Db } from '../db.ts';

export interface Ctx { cfg: Config; db: Db }

// Tool annotations (MCP spec; required for the Claude connector directory): a title, and whether
// the tool only reads (readOnly) or can change or end things irreversibly (destructive).
// openWorld: reaches beyond this service (other machines' sessions, LLM endpoints, agents).
type Hint = [title: string, kind: 'read' | 'write' | 'destructive', openWorld?: boolean];
const HINTS: Record<string, Hint> = {
  machine_list: ['List machines', 'read'],
  machine_status: ['Machine status', 'read'],
  session_list: ['List sessions', 'read'],
  session_read: ['Read session output', 'read'],
  session_start: ['Start a Claude Code session', 'write', true],
  session_send: ['Send a message to a session', 'write', true],
  session_wait: ['Wait for a session to reply', 'read'],
  session_approve: ['Answer a permission prompt', 'destructive', true],
  session_interrupt: ['Interrupt a session', 'write'],
  session_stop: ['Stop a session', 'destructive'],
  session_delete: ['Delete a session', 'destructive'],
  file_share: ['Share a file for download', 'write'],
  file_list: ['List shared files', 'read'],
  file_revoke: ['Revoke a shared file', 'write'],
  events_pending: ['What is waiting for me', 'read'],
  events_wait: ['Wait for the next event', 'read'],
  overview: ['Overview of all projects', 'read'],
  memory_search: ['Search shared memory', 'read'],
  memory_read: ['Read a memory file', 'read'],
  memory_write: ['Write a memory file', 'destructive'],
  memory_append: ['Append to a memory file', 'write'],
  memory_delete: ['Delete a memory file', 'destructive'],
  memory_link: ['Link shared knowledge to a project', 'write'],
  project_context: ['Project context', 'read'],
  project_sessions: ['Sessions of a project', 'read'],
  llm_list: ['List local models', 'read'],
  llm_run: ['Run a task on a local model', 'read', true],
  agent_run: ['Run a local agent', 'destructive', true],
  agent_status: ['Local agent job status', 'read'],
};

/** Tools a voice/chat assistant starts with when it begins coordinating sessions. */
const ENTRY_TOOLS = new Set(['events_pending', 'session_list', 'session_read', 'session_send', 'session_start']);
/** Shown (as `guidance`, never in the spoken summary) by an entry tool while nothing is watching events_wait. */
export const WATCH_GUIDANCE = 'You are now coordinating orchestrator sessions. Watch them live: open events_wait as a BACKGROUND wait (no cursor the first time, then the cursor from its last result; timeout 170) and re-open it after every result or timeout. Never block your reply on it and never announce empty polls; keep speaking normally and mention an event only if it matters (a session finished, needs approval, stopped or crashed). If you are already watching, do not open a second wait.';
const WATCH_GRACE_MS = 200_000; // a wait lasts up to 170 s, so a gap longer than this means nobody is watching

/**
 * Register a tool that returns `{ summary, ...detail }` (one speakable sentence first),
 * with every call written to the audit log.
 */
export function tool<S extends ZodRawShape>(
  server: McpServer, ctx: Ctx, name: string, description: string, shape: S,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<{ summary: string; [k: string]: unknown }>,
) {
  const hint = HINTS[name];
  if (!hint) throw new Error(`tool ${name} has no annotation in HINTS`);
  const [title, kind, openWorldHint = false] = hint;
  const annotations = { title, readOnlyHint: kind === 'read', destructiveHint: kind === 'destructive', openWorldHint };
  server.registerTool(name, { title, description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
    try {
      const out = await fn(args);
      ctx.db.audit(name, args);
      if (ENTRY_TOOLS.has(name) && !ctx.db.watching(WATCH_GRACE_MS)) out.guidance = WATCH_GUIDANCE;
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) }] };
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `Internal error: ${(e as Error).message}`;
      ctx.db.audit(name, args, msg);
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ summary: msg }) }] };
    }
  }) as never);
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
