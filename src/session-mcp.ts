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

export const SESSION_MCP_NAME = 'orchestrator-files';

const entry = (port: number | string, mcpToken: string) =>
  ({ type: 'http', url: `http://127.0.0.1:${port}/mcp-files`, headers: { Authorization: `Bearer ${filesToken(mcpToken)}` } });

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
  if (have?.url === want.url && have.headers?.Authorization === want.headers.Authorization) return ['session file tools: already configured'];
  for (const cmd of new Set(cfg.machines.filter((m) => m.local).map((m) => m.claude_cmd))) {
    if (have) await run(cmd, ['mcp', 'remove', SESSION_MCP_NAME, '--scope', 'user']); // stale (token rotated or port changed)
    // The JSON goes in on stdin, so the token never appears in the process list.
    const r = await run(cmd, ['mcp', 'add-json', '--scope', 'user', SESSION_MCP_NAME, '-'], JSON.stringify(want));
    log.push(r.code === 0 ? `session file tools: configured for ${cmd}` : `session file tools: ${cmd} failed (${r.out.trim().slice(0, 120)})`);
  }
  for (const l of log) console.log(l);
  return log;
}
