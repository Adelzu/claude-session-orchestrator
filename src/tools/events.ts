import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Status } from '../summarize.ts';
import { SESSION_RE } from '../tmux.ts';
import { ago, tool, type Ctx } from './common.ts';
import { projectOf, refresh, writeLog } from './sessions.ts';
import { isSessionId, isTranscriptPath } from '../transcript.ts';

/** Hook payload (Claude Code hook stdin JSON) → session status. Spec §13. */
export function statusFor(hook: { hook_event_name?: string; message?: string }): Status | undefined {
  if (hook.hook_event_name === 'Stop') return 'idle';
  if (hook.hook_event_name === 'SessionEnd') return 'stopped';
  if (hook.hook_event_name === 'Notification') {
    return /permission|approv|allow/i.test(hook.message ?? '') ? 'waiting_approval' : 'waiting_input';
  }
  return undefined;
}

/**
 * POST /events?session=cc-x&machine=gpu with the hook JSON as body. Returns an HTTP status code.
 * `machine` has already been authenticated by its per-machine token.
 */
export function ingest(ctx: Ctx, session: string, machine: string, body: unknown): number {
  if (!SESSION_RE.test(session)) return 400;
  const hook = (body ?? {}) as { hook_event_name?: string; message?: string; reason?: string; session_id?: unknown; transcript_path?: unknown };
  const status = statusFor(hook);
  if (!status) return 400;
  const existing = ctx.db.session(session);
  if (existing && existing.machine !== machine) return 403; // a machine may only report its own sessions
  if (!existing) {
    if (!ctx.cfg.machines.some((m) => m.id === machine)) return 404;
    ctx.db.upsertSession({ name: session, machine, project: projectOf(ctx, session), status: 'idle', remote_control: 0 });
  }
  const before = ctx.db.session(session)!;
  const msg = (hook.message ?? hook.reason)?.slice(0, 500) ?? null;
  ctx.db.setStatus(session, status, msg, `hook ${hook.hook_event_name}${hook.reason ? ` (${hook.reason})` : ''}`, true);
  ctx.db.setTranscript(session, isSessionId(hook.session_id) ? hook.session_id : null, isTranscriptPath(hook.transcript_path) ? hook.transcript_path : null);
  ctx.db.addEvent(session, hook.hook_event_name!, status, msg);
  // Ended outside session_stop (e.g. /exit typed in the Claude app): log it in the background.
  if (status === 'stopped' && before.status !== 'stopped') {
    const m = ctx.cfg.machines.find((x) => x.id === before.machine);
    if (m) void writeLog(ctx, before, m, hook.reason && `Ended: ${hook.reason}`);
  }
  return 204;
}

const MAX_WAIT_S = 170;

/** Block until a stream event after `cursor` exists (or the timeout passes). No cursor = only events from now on. */
export async function waitForEvent(ctx: Ctx, cursor: number | undefined, timeoutS: number, signal?: AbortSignal) {
  const from = cursor ?? ctx.db.lastEventId();
  const deadline = Date.now() + Math.min(Math.max(timeoutS, 0), MAX_WAIT_S) * 1000;
  for (;;) {
    const e = ctx.db.eventAfter(from);
    if (e) return { event: e, cursor: e.id };
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) return { event: null, cursor: from };
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); ctx.db.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, left);
      ctx.db.waiters.add(done);
      signal?.addEventListener('abort', done);
    });
  }
}

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'events_wait', `Wait for the next event from any session or background job: a session went idle (finished), is waiting for input or approval, stopped or crashed, or an agent job finished or failed. Returns ONE event (oldest first) with its id, or event=null after the timeout. Pass the returned cursor next time so nothing is missed or repeated; without a cursor you get only events from now on. timeout_seconds is capped at ${MAX_WAIT_S}; on null just call again with the same cursor.`,
    { cursor: z.number().int().min(0).optional().describe('The cursor from the previous result'), timeout_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S) },
    async ({ cursor, timeout_seconds }) => {
      const { event, cursor: next } = await waitForEvent(ctx, cursor, timeout_seconds);
      return event
        ? { summary: `${event.session}: ${event.type.replace('_', ' ')}. ${event.summary}`, event: { ...event, ts: new Date(event.ts).toISOString() }, cursor: next }
        : { summary: 'No new events.', event: null, cursor: next };
    });

  tool(server, ctx, 'events_pending', 'Sessions waiting for the user\'s answer or approval, oldest first. Call this first in voice mode.', {},
    async () => {
      await refresh(ctx); // some prompts (e.g. the startup import dialog) fire no hook; only the pane shows them
      const p = ctx.db.pending();
      return {
        summary: p.length
          ? `${p.length} waiting. ` + p.map((s) => `${s.project} on ${s.machine} needs ${s.status === 'waiting_approval' ? 'approval' : 'input'}, ${ago(s.status_since)}${s.last_message ? `: ${s.last_message}` : ''}.`).join(' ')
          : 'Nothing is waiting for you.',
        pending: p.map((s) => ({ session: s.name, project: s.project, machine: s.machine, status: s.status, since: new Date(s.status_since).toISOString(), message: s.last_message })),
      };
    });
}
