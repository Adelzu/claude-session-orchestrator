import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Db } from '../src/db.ts';
import type { Ctx } from '../src/tools/common.ts';
import { callerFor, ensureSessionMcp, SESSION_MCP_NAME } from '../src/session-mcp.ts';
import { filesToken } from '../src/auth.ts';
import type { Config } from '../src/config.ts';

// A stand-in for `claude` that implements just `mcp add-json` and `mcp remove` on a fake .claude.json.
const fake = (dir: string) => {
  const p = join(dir, 'claude');
  writeFileSync(p, `#!/usr/bin/env node
const fs = require('fs'); const cfg = process.env.FAKE_CFG + '/.claude.json';
const read = () => { try { return JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { return {}; } };
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CFG + '/calls.log', a.slice(0, 5).join(' ') + '\\n');
const d = read(); d.mcpServers ??= {};
if (a[0] === 'mcp' && a[1] === 'remove') { delete d.mcpServers[a[2]]; }
else if (a[0] === 'mcp' && a[1] === 'add-json') { d.mcpServers[a[4]] = JSON.parse(fs.readFileSync(0, 'utf8')); fs.writeFileSync(process.env.FAKE_CFG + '/stdin-seen', 'yes'); }
fs.writeFileSync(cfg, JSON.stringify(d));
`);
  chmodSync(p, 0o755);
  return p;
};
const cfgOf = (cmd: string): Config => ({ machines: [{ id: 'hub', local: true, os: 'linux', projects_root: '~', claude_cmd: cmd }, { id: 'gpu', ssh_host: 'gpu', os: 'linux', projects_root: '~', local: false, claude_cmd: 'claude' }], projects: [], endpoints: [], routing: [], agents: [] });
const calls = (dir: string) => existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).mcpServers[SESSION_MCP_NAME];

test('ensureSessionMcp: adds the entry once, with the derived token, over stdin; later runs change nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  process.env.FAKE_CFG = dir;
  const cmd = fake(dir);
  await ensureSessionMcp(cfgOf(cmd), { mcpToken: 'tok', port: 8787, configDir: dir });
  assert.deepEqual(saved(dir), { type: 'http', url: 'http://127.0.0.1:8787/mcp-files', headers: { Authorization: `Bearer ${filesToken('tok')}`, 'X-Orch-Pane': '${TMUX_PANE:-none}' } });
  assert.notEqual(saved(dir).headers.Authorization, 'Bearer tok'); // never the full-control token
  assert.deepEqual(calls(dir), ['mcp add-json --scope user orchestrator-files']);
  assert.equal(readFileSync(join(dir, 'stdin-seen'), 'utf8'), 'yes');
  const out = await ensureSessionMcp(cfgOf(cmd), { mcpToken: 'tok', port: 8787, configDir: dir });
  assert.match(out[0]!, /already configured/);
  assert.equal(calls(dir).length, 1, 'nothing written when it is already right');
});

test('ensureSessionMcp: a rotated token or a new port replaces the stale entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  process.env.FAKE_CFG = dir;
  const cmd = fake(dir);
  await ensureSessionMcp(cfgOf(cmd), { mcpToken: 'old', port: 8787, configDir: dir });
  await ensureSessionMcp(cfgOf(cmd), { mcpToken: 'new', port: 9000, configDir: dir });
  assert.equal(saved(dir).url, 'http://127.0.0.1:9000/mcp-files');
  assert.equal(saved(dir).headers.Authorization, `Bearer ${filesToken('new')}`);
  assert.deepEqual(calls(dir).map((c) => c.split(' ').slice(0, 2).join(' ')), ['mcp add-json', 'mcp remove', 'mcp add-json']);
});

test('ensureSessionMcp: only local machines are configured; a missing claude binary is reported, not thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  process.env.FAKE_CFG = dir;
  const bad = await ensureSessionMcp(cfgOf(join(dir, 'no-such-claude')), { mcpToken: 'tok', port: 8787, configDir: dir });
  assert.match(bad[0]!, /failed/);
  assert.equal(calls(dir).length, 0); // the ssh machine's "claude" was never run here
});

test('ensureSessionMcp: an entry from before the pane header is updated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  process.env.FAKE_CFG = dir;
  const cmd = fake(dir);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { [SESSION_MCP_NAME]: { type: 'http', url: 'http://127.0.0.1:8787/mcp-files', headers: { Authorization: `Bearer ${filesToken('tok')}` } } } }));
  await ensureSessionMcp(cfgOf(cmd), { mcpToken: 'tok', port: 8787, configDir: dir });
  assert.equal(saved(dir).headers['X-Orch-Pane'], '${TMUX_PANE:-none}');
});

test('callerFor: pane id -> adopted session, or the tmux session name; junk and unknown panes -> null', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cf-'));
  const old = { d: process.env.TMUX_TMPDIR, t: process.env.TMUX };
  process.env.TMUX_TMPDIR = tmp; delete process.env.TMUX; // a private tmux server, never the user's
  try {
    const ctx = { cfg: cfgOf('claude'), db: new Db(':memory:') } as unknown as Ctx;
    execSync('tmux new-session -d -s cc-pane-test -x 80 -y 24 "sleep 60"');
    const pane = execSync("tmux list-panes -a -F '#{pane_id}'").toString().trim().split('\n')[0]!;
    assert.deepEqual(await callerFor(ctx, pane, 1), { session: 'cc-pane-test', machine: 'hub' });
    // an adopted row for a pane wins over the tmux session name
    ctx.db.adoptSession({ name: 'cc-adopted', machine: 'hub', project: 'p', status: 'idle', target: '%77', tmux_session: 'mine', claude_id: null, claude_pid: null, remote_control: 0 });
    assert.deepEqual(await callerFor(ctx, '%77', 1), { session: 'cc-adopted', machine: 'hub' });
    assert.equal(await callerFor(ctx, '%9999', 1), null);       // no such pane
    assert.equal(await callerFor(ctx, 'none', 1), null);        // not in tmux
    assert.equal(await callerFor(ctx, "%1; rm -rf ~", 1), null); // never reaches a shell
    assert.equal(await callerFor(ctx, undefined, 1), null);
  } finally {
    try { execSync('tmux kill-server'); } catch { /* none */ }
    if (old.d === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = old.d;
    if (old.t !== undefined) process.env.TMUX = old.t;
  }
});
