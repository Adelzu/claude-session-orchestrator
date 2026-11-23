// Adopting Claude Code sessions that run in tmux but were not started by the orchestrator.
import { randomBytes } from 'node:crypto';
import { projectDir, type Config, type Machine } from './config.ts';
import type { Db } from './db.ts';
import { detectStatus } from './summarize.ts';
import { SESSION_RE, type Discovery } from './tmux.ts';

export const UNASSIGNED = 'unassigned';

export interface Resolved { cwd?: string; dirs?: Map<string, string> } // realpaths from the machine

/**
 * The project whose folder contains cwd (longest folder wins), or null. A path matches when it
 * matches as written or after realpath, on either side. `~` in config means the machine's $HOME;
 * when $HOME is unknown the machine's own resolution of the folder (real.dirs) is used instead.
 */
export function matchDetail(cfg: Config, m: Machine, home: string, cwd: string, real: Resolved = {}): { id: string; dir: string } | null {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  const cwds = [cwd, real.cwd].filter((x): x is string => !!x).map(norm);
  let best: { id: string; dir: string } | null = null;
  for (const p of cfg.projects) {
    const written = projectDir(m, p);
    const dirs: string[] = [];
    if (written === '~' || written.startsWith('~/')) { if (home) dirs.push(home + written.slice(1)); }
    else dirs.push(written);
    const r = real.dirs?.get(written);
    if (r) dirs.push(r);
    for (const d of dirs.map(norm)) {
      if (cwds.some((c) => c === d || c.startsWith(`${d}/`)) && (!best || d.length > best.dir.length)) best = { id: p.id, dir: d };
    }
  }
  return best;
}

export const matchProject = (cfg: Config, m: Machine, home: string, cwd: string, real?: Resolved): string | null =>
  matchDetail(cfg, m, home, cwd, real)?.id ?? null;

/** Project folders as configured for this machine, for discover() to resolve with realpath. */
export const projectDirs = (cfg: Config, m: Machine): string[] => cfg.projects.map((p) => projectDir(m, p));

/**
 * Track every Claude Code pane in `found` that we do not know yet. Panes inside cc-* tmux sessions
 * are left to the name-based path in refresh(). Returns the names of the new sessions.
 */
export function adoptPanes(cfg: Config, db: Db, m: Machine, found: Discovery): string[] {
  const added: string[] = [];
  for (const p of found.panes) {
    // cc-* tmux sessions belong to the orchestrator (name-based path in refresh()).
    if (SESSION_RE.test(p.session)) continue;
    const existing = db.adoptedRow(m.id, p.id);
    // Started by the orchestrator under another tmux name, or already tracked: never a second row.
    if (!existing && p.claude_id && db.hasLiveClaudeId(m.id, p.claude_id)) continue;
    const hit = matchDetail(cfg, m, found.home, p.cwd, { cwd: p.real_cwd, dirs: found.dirs });
    const project = hit?.id ?? UNASSIGNED;
    if (!existing || existing.project === UNASSIGNED) console.log(`adopt: ${existing ? 'rematch ' : ''}${m.id} ${p.id} cwd=${p.cwd} real=${p.real_cwd ?? '-'} home=${found.home || '-'} dir=${hit?.dir ?? '-'} -> ${project}`);
    let name: string;
    do name = `cc-${project}-${randomBytes(2).toString('hex')}`; while (db.session(name));
    // Insert, or update the row that already tracks this pane (rename, restart, stopped -> running,
    // unassigned -> a project that matches now).
    db.adoptSession({ name, machine: m.id, project, status: detectStatus(p.pane) ?? 'idle', target: p.id, tmux_session: p.session, claude_id: p.claude_id, claude_pid: p.claude_pid, remote_control: p.remote_control });
    if (!existing) added.push(name);
  }
  return added;
}
