// Gives every Claude Code session on this machine the file tools, with no manual setup: a user-scope MCP server
// entry (written with `claude mcp add-json`, Claude Code's own interface) pointing at the hub's /mcp-files endpoint.
// That endpoint serves only file_share, file_list and file_revoke, with its own derived token, and every share is still
// limited to FILE_SHARE_ROOTS. Running sessions pick the entry up when they next start (or reload MCP servers).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { filesToken } from './auth.ts';
import type { Config } from './config.ts';
import { run as runOn, q } from './transport/ssh.ts';
import { PANE_RE } from './tmux.ts';
import type { Caller } from './tools/files.ts';
import type { Ctx } from './tools/common.ts';

export const SESSION_MCP_NAME = 'orchestrator-files';

/**
 * `X-Orch-Pane` is expanded by Claude Code from the session's own environment ($TMUX_PANE, "none" outside tmux); the hub
 * maps it to the session name, so the dashboard can say who shared a file. It only labels; it grants nothing.
 */
const entry = (port: number | string, mcpToken: string) =>
  ({ type: 'http', url: `http://127.0.0.1:${port}/mcp-files`, headers: { Authorization: `Bearer ${filesToken(mcpToken)}`, 'X-Orch-Pane': '${TMUX_PANE:-none}' } });

/** The user-scope entry Claude Code has now (read only), if any. */
function current(configDir: string): { url?: string; headers?: Record<string, string> } | undefined {
  try { return JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')).mcpServers?.[SESSION_MCP_NAME]; } catch { return undefined; }
}

const run = (cmd: string, args: string[], input?: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('error', (e) => resolve({ code: null, out: e.message }));
  p.on('close', (code) => resolve({ code, out }));
  p.stdin.on('error', () => {});
  p.stdin.end(input);
});

/**
 * Make sure the entry exists and matches the current token, for each distinct Claude command of this machine's local
 * machines. Idempotent: nothing is written when it is already right. Returns what it did, for the log.
 */
export async function ensureSessionMcp(cfg: Config, o: { mcpToken: string; port: number | string; configDir?: string }): Promise<string[]> {
  const configDir = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? homedir();
  const want = entry(o.port, o.mcpToken);
  const log: string[] = [];
  const have = current(configDir);
  if (have?.url === want.url && JSON.stringify(have.headers) === JSON.stringify(want.headers)) return ['session file tools: already configured'];
  for (const cmd of new Set(cfg.machines.filter((m) => m.local).map((m) => m.claude_cmd))) {
    if (have) await run(cmd, ['mcp', 'remove', SESSION_MCP_NAME, '--scope', 'user']); // stale (token rotated or port changed)
    // The JSON goes in on stdin, so the token never appears in the process list.
    const r = await run(cmd, ['mcp', 'add-json', '--scope', 'user', SESSION_MCP_NAME, '-'], JSON.stringify(want));
    log.push(r.code === 0 ? `session file tools: configured for ${cmd}` : `session file tools: ${cmd} failed (${r.out.trim().slice(0, 120)})`);
  }
  for (const l of log) console.log(l);
  return log;
}

const seen = new Map<string, { at: number; caller: Caller | null }>();

/** Which session is behind this tmux pane id (header X-Orch-Pane)? Adopted rows by pane, else the tmux session's name. */
export async function callerFor(ctx: Ctx, pane: string | undefined, now = Date.now()): Promise<Caller | null> {
  if (!pane || !PANE_RE.test(pane)) return null;
  const hit = seen.get(pane);
  if (hit && now - hit.at < 60_000) return hit.caller;
  const m = ctx.cfg.machines.find((x) => x.local);
  let caller: Caller | null = null;
  if (m) {
    let name: string | null = ctx.db.adoptedRow(m.id, pane)?.name ?? null;
    if (!name) {
      const r = await runOn(m, `tmux display-message -p -t ${q(pane)} '#{session_name}'`, 3000);
      const n = r.stdout.trim();
      if (r.code === 0 && /^[\w.-]{1,40}$/.test(n)) name = n;
    }
    if (name) caller = { session: name, machine: m.id };
  }
  seen.set(pane, { at: now, caller });
  return caller;
}
