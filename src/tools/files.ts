// File handoff: share one file from this machine for download through the hosted dashboard.
// Bytes are streamed to the worker over the agent WebSocket (src/cloud.ts) and never stored in the cloud.
// The worker only serves a share to the signed-in owner; this module is the other half of the guard:
// allowed roots only, no dotfiles anywhere in the path, size cap, expiry, revoke.
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError } from '../config.ts';
import { tool, type Ctx } from './common.ts';

export const DEFAULT_TTL_MIN = 30;
export const MAX_TTL_MIN = 24 * 60;
/** Most bytes sent to the worker before it has acknowledged them. */
export const WINDOW_BYTES = 4 * 1024 * 1024;
const CHUNK = 256 * 1024;

export interface Limits { roots: string[]; maxBytes: number }

/** Roots come from FILE_SHARE_ROOTS (comma separated, ~ allowed). No roots configured = nothing can be shared. */
export function limits(env: NodeJS.ProcessEnv = process.env): Limits {
  const roots: string[] = [];
  for (const r of (env.FILE_SHARE_ROOTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try { roots.push(realpathSync(expand(r))); } catch { /* missing folder: ignored */ }
  }
  const mb = Number(env.FILE_SHARE_MAX_MB);
  return { roots, maxBytes: (Number.isFinite(mb) && mb > 0 ? mb : 1024) * 1024 * 1024 };
}

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p);

/** Display name for a download: one path segment, no control characters, quotes or slashes. */
export const safeName = (name: string) => {
  const n = basename(name).replace(/[\x00-\x1f\x7f"\\/]/g, '_').trim();
  return n || 'file';
};

const hasDotPart = (rel: string) => rel.split(sep).some((c) => c.startsWith('.'));

/** Validate a path against the limits. Returns the real path and its size; throws UserError. */
export function checkPath(path: string, lim: Limits): { real: string; size: number; mtimeMs: number } {
  if (!lim.roots.length) throw new UserError('File sharing is off: set FILE_SHARE_ROOTS on the hub to the folders that may be shared.');
  const given = expand(path.trim());
  if (!isAbsolute(given)) throw new UserError('Give an absolute path (or one starting with ~/).');
  const abs = resolve(given);
  let real: string;
  try { real = realpathSync(abs); } catch { throw new UserError(`No such file: ${abs}`); }
  const root = lim.roots.find((r) => real === r || real.startsWith(r + sep));
  if (!root) throw new UserError('That file is outside the folders allowed for sharing.');
  // Dotfiles and dot folders (.env, .ssh, .git, ...) are refused for the path as given and for where it really points.
  const rootAbs = lim.roots.find((r) => abs.startsWith(r + sep));
  if (hasDotPart(real.slice(root.length + 1)) || (rootAbs && hasDotPart(abs.slice(rootAbs.length + 1))) || basename(abs).startsWith('.')) {
    throw new UserError('Dotfiles and files in dot folders (such as .env or .ssh) cannot be shared.');
  }
  const st = statSync(real);
  if (!st.isFile()) throw new UserError('Only regular files can be shared, not folders.');
  if (st.size > lim.maxBytes) throw new UserError(`File is ${st.size} bytes; the limit is ${lim.maxBytes} bytes.`);
  return { real, size: st.size, mtimeMs: st.mtimeMs };
}

interface ShareRow { id: string; path: string; name: string; size: number; created: number; expires: number; revoked: number }

const live = (ctx: Ctx, now = Date.now()) =>
  ctx.db.db.prepare(`SELECT * FROM shares WHERE revoked = 0 AND expires > ? ORDER BY created DESC`).all(now) as unknown as ShareRow[];

/** Download base URL: the worker this agent is connected to (ORCH_CLOUD_URL is wss://host/agent). */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.ORCH_CLOUD_URL) return null;
  const u = new URL(env.ORCH_CLOUD_URL);
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

const urlOf = (base: string, s: { id: string; name: string }) => `${base}/f/${s.id}/${encodeURIComponent(s.name)}`;

export function share(ctx: Ctx, path: string, ttlMin = DEFAULT_TTL_MIN, now = Date.now(), lim = limits(), base = baseUrl()) {
  if (!base) throw new UserError('File sharing needs agent mode (ORCH_CLOUD_URL) so the dashboard can serve the file.');
  if (!Number.isInteger(ttlMin) || ttlMin < 1 || ttlMin > MAX_TTL_MIN) throw new UserError(`ttl_minutes must be 1 to ${MAX_TTL_MIN} (24 h).`);
  const { real, size } = checkPath(path, lim);
  const row: ShareRow = { id: randomBytes(16).toString('base64url'), path: real, name: safeName(real), size, created: now, expires: now + ttlMin * 60_000, revoked: 0 };
  ctx.db.db.prepare(`INSERT INTO shares (id, path, name, size, created, expires, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)`)
    .run(row.id, row.path, row.name, row.size, row.created, row.expires);
  return { ...row, url: urlOf(base, row) };
}

export function list(ctx: Ctx, now = Date.now(), base = baseUrl()) {
  return live(ctx, now).map((s) => ({ id: s.id, name: s.name, size: s.size, expires: s.expires, url: base ? urlOf(base, s) : null }));
}

const active = new Map<string, Set<AbortController>>();

export function revoke(ctx: Ctx, id: string): boolean {
  const r = ctx.db.db.prepare(`UPDATE shares SET revoked = 1 WHERE id = ? AND revoked = 0`).run(id);
  for (const c of active.get(id) ?? []) c.abort(); // running downloads stop too
  return Number(r.changes) > 0;
}

/** Parse a single `bytes=a-b` range. Anything else (multi-range, other units) is ignored: the full file is served. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'full' | 'unsatisfiable' {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'full';
  let start: number, end: number;
  if (m[1] === '') { // suffix: last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return 'full'; // invalid: ignored per RFC 9110
  }
  return start >= size ? 'unsatisfiable' : { start, end };
}

export interface Opened { status: number; headers: Record<string, string>; message?: string; stream?: Readable; signal?: AbortSignal; close?: () => void }

/** Resolve one download request. Everything is checked again here, so a stale or revoked share never serves. */
export function open(ctx: Ctx, id: string, opts: { range?: string; ifRange?: string; head?: boolean } = {}, now = Date.now(), lim = limits()): Opened {
  const fail = (status: number, message: string): Opened => ({ status, headers: {}, message });
  const row = ctx.db.db.prepare(`SELECT * FROM shares WHERE id = ?`).get(id) as ShareRow | undefined;
  if (!row || row.revoked || row.expires <= now) return fail(404, 'This file is not shared (any more).');
  let info: ReturnType<typeof checkPath>;
  try { info = checkPath(row.path, lim); } catch (e) { return fail(e instanceof UserError && /No such file/.test(e.message) ? 404 : 403, (e as Error).message); }
  const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag,
    'content-disposition': `attachment; filename="${row.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'last-modified': new Date(info.mtimeMs).toUTCString(),
  };
  let range = parseRange(opts.range, info.size);
  if (opts.ifRange && opts.ifRange !== etag) range = 'full'; // the file changed: send it all
  if (range === 'unsatisfiable') return { status: 416, headers: { ...headers, 'content-range': `bytes */${info.size}` } };
  const [start, end, status] = range === 'full' ? [0, info.size - 1, 200] : [range.start, range.end, 206];
  headers['content-length'] = String(info.size === 0 ? 0 : end - start + 1);
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  if (opts.head || info.size === 0) return { status, headers };
  const ac = new AbortController();
  const set = active.get(id) ?? new Set();
  set.add(ac); active.set(id, set);
  const stream = createReadStream(info.real, { start, end, signal: ac.signal, highWaterMark: CHUNK });
  const forget = () => { set.delete(ac); if (!set.size && active.get(id) === set) active.delete(id); };
  const close = () => { ac.abort(); forget(); };
  stream.once('close', forget);
  return { status, headers, stream, signal: ac.signal, close };
}

export interface Peer { send(data: string | Uint8Array): void }
interface Transfer { sent: number; acked: number; cancelled: boolean; wake?: () => void; close?: () => void }

/**
 * Serves the worker's file requests over the agent socket. Frames (the worker has the same format):
 *   worker -> agent: {type:'file', id, share, range?, ifRange?, head?} | {type:'ack', id, bytes} | {type:'cancel', id}
 *   agent -> worker: {type:'file-head', id, status, headers} then binary frames (36-byte request id + data),
 *                    then {type:'file-end', id} or {type:'file-error', id, message}
 */
export class FileTransfers {
  private transfers = new Map<string, Transfer>();
  private ctx: Ctx;
  private peer: Peer;
  private lim: () => Limits;
  constructor(ctx: Ctx, peer: Peer, lim: () => Limits = limits) { this.ctx = ctx; this.peer = peer; this.lim = lim; }

  handles(type: unknown) { return type === 'file' || type === 'ack' || type === 'cancel'; }

  async onMessage(msg: { type?: string; id?: string; share?: string; range?: string; ifRange?: string; head?: boolean; bytes?: number }) {
    const id = msg.id;
    if (typeof id !== 'string' || id.length !== 36) return;
    if (msg.type === 'ack') {
      const t = this.transfers.get(id);
      if (t && typeof msg.bytes === 'number') { t.acked = Math.max(t.acked, msg.bytes); t.wake?.(); }
    } else if (msg.type === 'cancel') {
      const t = this.transfers.get(id);
      if (t) { t.cancelled = true; t.close?.(); t.wake?.(); }
    } else if (msg.type === 'file' && typeof msg.share === 'string' && !this.transfers.has(id)) {
      await this.serve(id, msg.share, msg);
    }
  }

  /** Connection lost: stop every running transfer. */
  closeAll() { for (const t of this.transfers.values()) { t.cancelled = true; t.close?.(); t.wake?.(); } }

  private async serve(id: string, share: string, msg: { range?: string; ifRange?: string; head?: boolean }) {
    const t: Transfer = { sent: 0, acked: 0, cancelled: false };
    this.transfers.set(id, t);
    try {
      const o = open(this.ctx, share, { range: msg.range, ifRange: msg.ifRange, head: msg.head }, Date.now(), this.lim());
      t.close = o.close;
      o.signal?.addEventListener('abort', () => t.wake?.()); // a revoke must also free a transfer that waits for an ack
      this.peer.send(JSON.stringify({ type: 'file-head', id, status: o.status, headers: o.headers, message: o.message }));
      if (o.stream) {
        const idBytes = Buffer.from(id, 'ascii');
        for await (const chunk of o.stream as AsyncIterable<Buffer>) {
          if (t.cancelled) break;
          while (!t.cancelled && !o.signal?.aborted && t.sent - t.acked >= WINDOW_BYTES) await new Promise<void>((r) => { t.wake = r; });
          if (t.cancelled) break;
          if (o.signal?.aborted) throw Object.assign(new Error('revoked'), { name: 'AbortError' });
          this.peer.send(Buffer.concat([idBytes, chunk]));
          t.sent += chunk.length;
        }
      }
      if (!t.cancelled) this.peer.send(JSON.stringify({ type: 'file-end', id }));
    } catch (e) {
      if (!t.cancelled) this.peer.send(JSON.stringify({ type: 'file-error', id, message: (e as Error).name === 'AbortError' ? 'The share was revoked.' : 'Read failed.' }));
    } finally {
      t.close?.();
      this.transfers.delete(id);
    }
  }
}

const humanSize = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'file_share',
    'Share one file from the hub machine for download. Returns a link that works only for the signed-in owner (dashboard sign-in); nothing is stored in the cloud. Allowed folders only, no dotfiles, size cap. Default 30 minutes, max 24 h.',
    { path: z.string().describe('Absolute path (or ~/...) of the file on the hub'), ttl_minutes: z.number().int().min(1).max(MAX_TTL_MIN).default(DEFAULT_TTL_MIN).describe('How long the link works, 1 to 1440 minutes') },
    async ({ path, ttl_minutes }) => {
      const s = share(ctx, path, ttl_minutes);
      return { summary: `Shared ${s.name} (${humanSize(s.size)}) for ${ttl_minutes} minutes. Open it signed in: ${s.url}`, id: s.id, name: s.name, size: s.size, expires: new Date(s.expires).toISOString(), url: s.url };
    });

  tool(server, ctx, 'file_list', 'List the files currently shared (name, size, expiry, link).', {},
    async () => {
      const files = list(ctx).map((f) => ({ ...f, expires: new Date(f.expires).toISOString() }));
      return { summary: files.length ? `${files.length} file${files.length === 1 ? '' : 's'} shared.` : 'No files are shared.', files };
    });

  tool(server, ctx, 'file_revoke', 'Stop sharing a file now; a download in progress is cut.',
    { id: z.string().min(8).max(64).describe('Share id from file_list') },
    async ({ id }) => {
      if (!revoke(ctx, id)) throw new UserError('No such active share.');
      return { summary: 'Share revoked.' };
    });
}
