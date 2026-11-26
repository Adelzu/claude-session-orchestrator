// SQLite via Node's built-in node:sqlite (no native build step, unlike better-sqlite3).
import { DatabaseSync } from 'node:sqlite';
import type { Status } from './summarize.ts';

/** Stored in remote_control when we cannot tell (Remote Control may have been turned on after launch). */
export const REMOTE_CONTROL_UNKNOWN = -1;

export interface SessionRow {
  name: string;
  machine: string;
  project: string;
  status: Status;
  remote_control: number;     // 1 on, 0 off, REMOTE_CONTROL_UNKNOWN (-1) for adopted sessions started without the flag
  status_since: number;
  last_message: string | null;
  claude_id: string | null;   // Claude Code session id (we pass --session-id, or a hook reports it)
  transcript: string | null;  // transcript path reported by a hook
  created: number | null;     // when the session started (null for rows from before this column)
  target: string | null;      // adopted sessions: tmux pane id (%N) running Claude Code; null for native ones
  tmux_session: string | null; // adopted sessions: the user's own tmux session name
  claude_pid: number | null;   // adopted sessions: pid of the Claude Code process in the pane (changes when it restarts)
  tmux_orig: string | null;    // adopted sessions: the tmux session's name before we renamed it to cc-<name>
}

export class Db {
  db: DatabaseSync;
  constructor(path = process.env.DB_PATH ?? 'orchestrator.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        name TEXT PRIMARY KEY, machine TEXT NOT NULL, project TEXT NOT NULL,
        status TEXT NOT NULL, remote_control INTEGER NOT NULL DEFAULT 1,
        status_since INTEGER NOT NULL, last_message TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, session TEXT NOT NULL, hook TEXT NOT NULL,
        status TEXT NOT NULL, message TEXT, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_failures (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, started INTEGER NOT NULL, finished INTEGER);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tool TEXT NOT NULL,
        args TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    `);
    // Columns added after the first release; ALTER fails harmlessly when they already exist.
    for (const col of ['claude_id TEXT', 'transcript TEXT', 'created INTEGER', 'target TEXT', 'tmux_session TEXT', 'claude_pid INTEGER', 'tmux_orig TEXT']) {
      try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    for (const col of ['type TEXT', 'summary TEXT']) {
      try { this.db.exec(`ALTER TABLE events ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    this.pruneEvents();
    for (const col of ['grp TEXT', 'label TEXT', 'by_session TEXT', 'by_machine TEXT']) {
      try { this.db.exec(`ALTER TABLE shares ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    // One row per adopted pane: machine + tmux pane id. Duplicates from earlier versions go first
    // (oldest row wins), or the unique index below could not be created.
    const removed = this.dedupeAdopted();
    if (removed) console.log(`db: removed ${removed} duplicate adopted session(s), kept the oldest of each pane`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sessions_adopted_pane ON sessions (machine, target) WHERE target IS NOT NULL`);
  }

  /** Delete adopted rows that share machine + pane with an older row. Returns how many were removed. */
  dedupeAdopted(): number {
    const dups = this.db.prepare(`SELECT name FROM sessions WHERE target IS NOT NULL
      AND rowid NOT IN (SELECT MIN(rowid) FROM sessions WHERE target IS NOT NULL GROUP BY machine, target)`).all() as { name: string }[];
    for (const d of dups) this.deleteSession(d.name);
    return dups.length;
  }

  /** Forget a session completely: its row and its events. */
  deleteSession(name: string) {
    this.db.prepare(`DELETE FROM events WHERE session = ?`).run(name);
    this.db.prepare(`DELETE FROM sessions WHERE name = ?`).run(name);
  }

  setTranscript(name: string, claudeId: string | null, transcript: string | null) {
    this.db.prepare(`UPDATE sessions SET claude_id = COALESCE(?, claude_id), transcript = COALESCE(?, transcript) WHERE name = ?`)
      .run(claudeId, transcript, name);
  }

  /** The row tracking this pane (any status), if any. */
  adoptedRow(machine: string, target: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE machine = ? AND target = ?`).get(machine, target) as SessionRow | undefined;
  }

  /** Is this Claude Code session id already tracked (by the orchestrator or adopted) and not stopped? */
  hasLiveClaudeId(machine: string, claudeId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sessions WHERE machine = ? AND claude_id = ? AND status != 'stopped'`).get(machine, claudeId);
  }

  /**
   * Track a Claude Code pane that was started outside the orchestrator. Idempotent: the pane
   * (machine + tmux pane id) is the identity, so a repeat, a concurrent scan, a renamed tmux session
   * or a restarted Claude Code updates the existing row instead of adding another.
   */
  adoptSession(s: { name: string; machine: string; project: string; status: Status; target: string; tmux_session: string; claude_id: string | null; claude_pid: number | null; remote_control: number; tmux_orig?: string | null }) {
    const now = Date.now();
    const was = this.adoptedRow(s.machine, s.target)?.status;
    if (was === 'stopped' && s.status !== 'stopped') console.log(`status: ${s.name} stopped -> ${s.status} (adopt scan)`);
    this.db.prepare(`INSERT INTO sessions (name, machine, project, status, remote_control, status_since, created, claude_id, claude_pid, target, tmux_session, tmux_orig)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (machine, target) WHERE target IS NOT NULL DO UPDATE SET
        tmux_session = excluded.tmux_session,
        tmux_orig = COALESCE(sessions.tmux_orig, excluded.tmux_orig),
        project = CASE WHEN sessions.project = 'unassigned' THEN excluded.project ELSE sessions.project END,
        transcript = CASE WHEN sessions.claude_pid IS excluded.claude_pid AND sessions.claude_id IS excluded.claude_id THEN sessions.transcript ELSE NULL END,
        claude_id = excluded.claude_id, claude_pid = excluded.claude_pid,
        status_since = CASE WHEN sessions.status = 'stopped' THEN excluded.status_since ELSE sessions.status_since END,
        status = CASE WHEN sessions.status = 'stopped' THEN excluded.status ELSE sessions.status END`)
      .run(s.name, s.machine, s.project, s.status, s.remote_control, now, now, s.claude_id, s.claude_pid, s.target, s.tmux_session, s.tmux_orig ?? null);
  }

  /**
   * Give a session row a new name (its events follow). False when another adopted row holds that name.
   * A native row with that name is a leftover of a hook event that arrived before the rename: it is dropped.
   */
  renameSession(from: string, to: string): boolean {
    if (from === to) return true;
    const clash = this.session(to);
    if (clash?.target) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (clash) this.deleteSession(to);
      this.db.prepare(`UPDATE events SET session = ? WHERE session = ?`).run(to, from);
      this.db.prepare(`UPDATE sessions SET name = ? WHERE name = ?`).run(to, from);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return true;
  }

  /** Claude Code runs in this adopted row's pane again (the row was stopped): back to `status`. */
  reviveAdopted(name: string, status: Status, claudeId: string | null, claudePid: number | null) {
    this.setStatus(name, status, null, 'refresh: claude running in its pane');
    this.db.prepare(`UPDATE sessions SET claude_id = COALESCE(?, claude_id), claude_pid = COALESCE(?, claude_pid) WHERE name = ?`).run(claudeId, claudePid, name);
  }

  setRemoteControl(name: string, value: number) {
    this.db.prepare(`UPDATE sessions SET remote_control = ? WHERE name = ?`).run(value, name);
  }

  upsertSession(s: Omit<SessionRow, 'status_since' | 'last_message' | 'claude_id' | 'transcript' | 'created' | 'target' | 'tmux_session' | 'claude_pid' | 'tmux_orig'>) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO sessions (name, machine, project, status, remote_control, status_since, created)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET machine = excluded.machine, project = excluded.project,
        status = excluded.status, remote_control = excluded.remote_control, status_since = excluded.status_since,
        created = excluded.created, claude_id = NULL, transcript = NULL`)
      .run(s.name, s.machine, s.project, s.status, s.remote_control, now, now);
  }

  /** Every session ever tracked for a project, newest first. */
  projectSessions(project: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE project = ? ORDER BY COALESCE(created, status_since) DESC`)
      .all(project) as unknown as SessionRow[];
  }

  /** Every change of status is logged with its source (hook, refresh, discovery, stop, ...). A session that stops working (idle, waiting, stopped) also lands in the event stream; `force` (hooks) does so even without a change. */
  setStatus(name: string, status: Status, message: string | null = null, source = 'unknown', force = false) {
    const before = this.session(name)?.status;
    if (before !== status) console.log(`status: ${name} ${before ?? '-'} -> ${status} (${source})`);
    this.db.prepare(`UPDATE sessions SET status = ?, status_since = ?, last_message = ? WHERE name = ?`)
      .run(status, Date.now(), message, name);
    const type = status === 'stopped' ? (/tmux session is gone|no claude in its pane/.test(source) ? 'crashed' : 'stopped')
      : status === 'waiting_approval' ? 'approval' : status === 'idle' || status === 'waiting_input' ? status : null;
    if (type && (force || before !== status)) this.emit(type, name, message ?? (type === 'idle' ? 'finished its work' : type === 'crashed' ? `ended unexpectedly (${source})` : type === 'stopped' ? 'stopped' : type === 'approval' ? 'needs approval' : 'is waiting for you'));
  }

  /** Callers of events_wait parked until the next event. */
  waiters = new Set<() => void>();

  /** Add to the event stream (the events_wait queue). Same session + type within 5 s is one event (a hook and a pane refresh can both see it). */
  emit(type: string, session: string, summary: string): number | null {
    const now = Date.now();
    if (this.db.prepare(`SELECT 1 FROM events WHERE type = ? AND session = ? AND ts > ?`).get(type, session, now - 5000)) return null;
    const id = Number(this.db.prepare(`INSERT INTO events (session, hook, status, message, ts, type, summary) VALUES (?, 'emit', ?, NULL, ?, ?, ?)`)
      .run(session, type, now, type, summary.slice(0, 500)).lastInsertRowid);
    for (const w of [...this.waiters]) w();
    return id;
  }

  /** The id of the newest stream event (0 if none): the cursor a caller starts from to see only new events. */
  lastEventId(): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE type IS NOT NULL`).get() as { n: number }).n;
  }

  /** The oldest stream event after `cursor`. */
  eventAfter(cursor: number) {
    return this.db.prepare(`SELECT id, type, session, summary, ts FROM events WHERE type IS NOT NULL AND id > ? ORDER BY id LIMIT 1`).get(cursor) as
      { id: number; type: string; session: string; summary: string; ts: number } | undefined;
  }

  /** A failed brain push (kept 7 days, like events). */
  addPushFailure(error: string) {
    this.db.prepare(`INSERT INTO push_failures (ts, error) VALUES (?, ?)`).run(Date.now(), error.slice(0, 500));
    this.pruneEvents();
  }

  /** Keep 7 days and at most the newest 10000 events; failed-push log entries also 7 days. */
  pruneEvents() {
    this.db.prepare(`DELETE FROM push_failures WHERE ts < ?`).run(Date.now() - 7 * 86400_000);
    this.db.prepare(`DELETE FROM events WHERE ts < ? OR id <= (SELECT COALESCE(MAX(id), 0) - 10000 FROM events)`).run(Date.now() - 7 * 86400_000);
  }

  session(name: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE name = ?`).get(name) as SessionRow | undefined;
  }

  sessions() {
    return this.db.prepare(`SELECT * FROM sessions`).all() as unknown as SessionRow[];
  }

  pending() {
    return this.db.prepare(`SELECT * FROM sessions WHERE status IN ('waiting_input', 'waiting_approval')
      ORDER BY status_since ASC`).all() as unknown as SessionRow[];
  }

  addEvent(session: string, hook: string, status: Status, message: string | null) {
    this.db.prepare(`INSERT INTO events (session, hook, status, message, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(session, hook, status, message, Date.now());
  }

  addJob(id: string, agent: string, task: string) {
    this.db.prepare(`INSERT INTO jobs (id, agent, task, status, started) VALUES (?, ?, ?, 'running', ?)`)
      .run(id, agent, task, Date.now());
  }

  finishJob(id: string, status: 'done' | 'failed', result: string) {
    this.db.prepare(`UPDATE jobs SET status = ?, result = ?, finished = ? WHERE id = ?`)
      .run(status, result, Date.now(), id);
    const j = this.job(id);
    if (j) this.emit(status === 'done' ? 'job_done' : 'job_failed', `job:${j.agent}`, `job ${id} ${status}: ${(status === 'done' ? j.task : result).slice(0, 200)}`);
  }

  job(id: string) {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      { id: string; agent: string; task: string; status: string; result: string | null; started: number; finished: number | null } | undefined;
  }

  /** Jobs still 'running' after a restart lost their worker. */
  failOrphanJobs() {
    this.db.prepare(`UPDATE jobs SET status = 'failed', result = 'orchestrator restarted' WHERE status = 'running'`).run();
  }

  audit(tool: string, args: unknown, error?: string) {
    this.db.prepare(`INSERT INTO audit (ts, tool, args, ok, error) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), tool, JSON.stringify(args ?? {}), error ? 0 : 1, error ?? null);
  }
}
