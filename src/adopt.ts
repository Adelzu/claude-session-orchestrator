// Adopting Claude Code sessions that run in tmux but were not started by the orchestrator.
import { randomBytes } from 'node:crypto';
import { projectDir, type Config, type Machine } from './config.ts';
import type { Db } from './db.ts';
import { detectStatus } from './summarize.ts';
import { SESSION_RE, type Discovery } from './tmux.ts';

export const UNASSIGNED = 'unassigned';

/** The project whose folder contains cwd (longest folder wins), or null. `~` in config means the machine's $HOME. */
export function matchProject(cfg: Config, m: Machine, home: string, cwd: string): string | null {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  const c = norm(cwd);
  let best: { id: string; len: number } | null = null;
  for (const p of cfg.projects) {
    let dir = projectDir(m, p);
    if (dir === '~' || dir.startsWith('~/')) {
      if (!home) continue;
      dir = home + dir.slice(1);
    }
    dir = norm(dir);
    if ((c === dir || c.startsWith(`${dir}/`)) && (!best || dir.length > best.len)) best = { id: p.id, len: dir.length };
  }
  return best?.id ?? null;
}

/**
 * Track every Claude Code pane in `found` that we do not know yet. Panes inside cc-* tmux sessions
 * are left to the name-based path in refresh(). Returns the names of the new sessions.
 */
export function adoptPanes(cfg: Config, db: Db, m: Machine, found: Discovery): string[] {
  const tracked = new Set(db.sessions().filter((r) => r.machine === m.id && r.target && r.status !== 'stopped').map((r) => r.target));
  const added: string[] = [];
  for (const p of found.panes) {
    if (SESSION_RE.test(p.session) || tracked.has(p.id)) continue;
    const project = matchProject(cfg, m, found.home, p.cwd) ?? UNASSIGNED;
    let name: string;
    do name = `cc-${project}-${randomBytes(2).toString('hex')}`; while (db.session(name));
    db.adoptSession({ name, machine: m.id, project, status: detectStatus(p.pane) ?? 'idle', target: p.id, tmux_session: p.session, claude_id: p.claude_id });
    added.push(name);
  }
  return added;
}
