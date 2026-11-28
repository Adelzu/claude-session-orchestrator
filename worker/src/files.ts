// Pure helpers for the file handoff on the worker (no Cloudflare imports, so node can test them).
// Frame format shared with the hub (src/tools/files.ts):
//   worker -> agent: {type:'file', id, share, range?, ifRange?, head?} | {type:'ack', id, bytes} | {type:'cancel', id}
//   agent -> worker: {type:'file-head', id, status, headers, message?}, binary frames = 36-byte request id + data,
//                    then {type:'file-end', id} or {type:'file-error', id, message}

export const REQ_ID_LEN = 36;

/** `/f/<id>/<name>` -> the share id. The name segment is only for the download manager and is ignored. */
export function parseFilePath(pathname: string): string | null {
  return /^\/f\/([A-Za-z0-9_-]{16,64})(?:\/[^/]*)?$/.exec(pathname)?.[1] ?? null;
}

export function decodeFrame(buf: ArrayBuffer): { id: string; data: Uint8Array } | null {
  if (buf.byteLength < REQ_ID_LEN) return null;
  const id = new TextDecoder().decode(new Uint8Array(buf, 0, REQ_ID_LEN));
  return /^[0-9a-f-]{36}$/.test(id) ? { id, data: new Uint8Array(buf, REQ_ID_LEN) } : null;
}

export const parseViewPath = (pathname: string): string | null =>
  /^\/view\/([A-Za-z0-9_-]{16,64})(?:\/[^/]*)?$/.exec(pathname)?.[1] ?? null;

/** What the dashboard offers for a file, by extension (the hub decides again; HTML and SVG are never viewable). */
export type ViewKind = 'image' | 'pdf' | 'text' | null;
export const viewKind = (name: string): ViewKind =>
  /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name) ? 'image' : /\.pdf$/i.test(name) ? 'pdf' : /\.(txt|log|md|csv|json)$/i.test(name) ? 'text' : null;

/** Types that may be served inline. Anything else is forced to a download here, whatever the agent said. */
export const SAFE_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'application/pdf', 'text/plain; charset=utf-8']);

export interface FileRow { id: string; name: string; size: number; expires: number; group: string | null; label: string | null; created: number; session: string | null; machine: string | null }
export interface ViewItem { id: string; name: string; label: string | null }
const byNewest = (a: FileRow, b: FileRow) => b.created - a.created || a.name.localeCompare(b.name);

/** Named groups newest share first, then the ungrouped files; inside a group: files newest first, sub-labels in the order they first appear. */
export function groupFiles(items: FileRow[]): { name: string | null; labels: { label: string | null; items: FileRow[] }[] }[] {
  const groups = new Map<string | null, FileRow[]>();
  for (const f of [...items].sort(byNewest)) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  const newest = (n: string | null) => groups.get(n)![0]!.created;
  const names = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : newest(b) - newest(a) || a.localeCompare(b)));
  return names.map((name) => {
    const labels: { label: string | null; items: FileRow[] }[] = [];
    for (const f of groups.get(name)!) {
      const same = labels.find((l) => l.label === f.label);
      if (same) same.items.push(f); else labels.push({ label: f.label, items: [f] });
    }
    return { name, labels };
  });
}

/** The images the viewer steps through: those in the same group as `id` (or the ungrouped ones), in display order. */
export function carouselOf(items: FileRow[], id: string): { items: ViewItem[]; index: number } | null {
  const me = items.find((f) => f.id === id);
  if (!me) return null;
  const list = groupFiles(items.filter((f) => f.group === me.group && viewKind(f.name) === 'image'))[0]?.labels.flatMap((l) => l.items) ?? [];
  const index = list.findIndex((f) => f.id === id);
  return index < 0 ? null : { items: list.map((f) => ({ id: f.id, name: f.name, label: f.label })), index };
}

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'content-disposition', 'last-modified'];

/** Only known headers from the agent pass through; the security headers are ours. */
export function responseHeaders(from: Record<string, string>): Headers {
  const h = new Headers();
  for (const k of PASS) if (typeof from[k] === 'string') h.set(k, from[k]);
  // Inline only for the safe types; anything else is a download, even if the agent asked for inline.
  const type = h.get('content-type') ?? '';
  const inline = /^inline/i.test(h.get('content-disposition') ?? '') && SAFE_INLINE.has(type);
  if (!inline) {
    h.set('content-type', 'application/octet-stream');
    h.set('content-disposition', (h.get('content-disposition') ?? 'attachment').replace(/^inline/i, 'attachment'));
  }
  h.set('cache-control', 'private, no-store');
  h.set('x-content-type-options', 'nosniff');
  // PDF viewers do not work inside a CSP sandbox; everything else gets it.
  if (!(inline && type === 'application/pdf')) h.set('content-security-policy', "default-src 'none'; sandbox");
  return h;
}

export interface HeadMsg { status: number; headers: Record<string, string>; message?: string }

/** One download: the head from the agent, then a body stream with backpressure (acks) and an idle timeout. */
export class Download {
  readonly id: string;
  readonly head: Promise<HeadMsg>;
  readonly body: ReadableStream<Uint8Array>;
  onClosed?: () => void;
  private resolveHead!: (h: HeadMsg) => void;
  private headDone = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private received = 0;
  private acked = 0;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private send: (m: object) => void;
  private idleMs: number;

  constructor(id: string, send: (m: object) => void, opts: { highWaterMark?: number; idleMs?: number } = {}) {
    this.id = id; this.send = send; this.idleMs = opts.idleMs ?? 120_000;
    this.head = new Promise((r) => { this.resolveHead = r; });
    this.body = new ReadableStream<Uint8Array>({
      start: (c) => { this.controller = c; },
      pull: () => this.ack(),
      cancel: () => { if (!this.done) { this.send({ type: 'cancel', id: this.id }); this.finish(); } },
    }, { highWaterMark: opts.highWaterMark ?? 2 * 1024 * 1024, size: (c) => c.byteLength });
    this.arm(15_000); // the agent must answer the request quickly
  }

  /** Tell the agent how much has been taken in; it never sends more than its window beyond this. */
  private ack() {
    if (this.received > this.acked) { this.acked = this.received; this.send({ type: 'ack', id: this.id, bytes: this.acked }); }
    this.arm();
  }

  /** The agent owes us data only while everything it sent was acked; a slow client is not an idle agent. */
  private arm(ms = this.idleMs) {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.done || this.received !== this.acked) return;
    this.timer = setTimeout(() => {
      if (this.done) return;
      this.send({ type: 'cancel', id: this.id });
      this.fail('The agent stopped sending.', 504);
    }, ms);
  }

  onHead(h: HeadMsg) { if (!this.headDone) { this.headDone = true; this.resolveHead(h); this.arm(); } }
  onChunk(data: Uint8Array) {
    if (this.done) return;
    this.received += data.byteLength;
    this.controller.enqueue(data);
    this.arm();
  }
  onEnd() { if (!this.done) { this.finish(); try { this.controller.close(); } catch { /* already cancelled */ } } }
  /** Error before the head: the caller gets a plain error response; after it: the body stream errors. */
  fail(message: string, status = 502) {
    if (this.done) return;
    if (!this.headDone) this.onHead({ status, headers: {}, message });
    this.finish();
    try { this.controller.error(new Error(message)); } catch { /* already closed */ }
  }
  private finish() { this.done = true; if (this.timer !== null) clearTimeout(this.timer); this.onClosed?.(); }
}

export const humanSize = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;

/** "cc-filetest on hub"; files shared through the main endpoint (the Claude app, scripts) say "orchestrator". */
export const sharedBy = (f: Pick<FileRow, 'session' | 'machine'>) => (f.session ? `${f.session}${f.machine ? ` on ${f.machine}` : ''}` : 'orchestrator');
/** The sidebar key of whoever shared a file: the session on its machine, or the main endpoint ("o:"). */
export const sessionKey = (f: Pick<FileRow, 'session' | 'machine'>) => (f.session ? `s:${f.session}|${f.machine ?? ''}` : 'o:');

/** Sessions that have shared files, with file counts, the most recent sharer first. */
export function sessionsOf(items: FileRow[]): { key: string; session: string | null; machine: string | null; count: number; latest: number }[] {
  const m = new Map<string, { key: string; session: string | null; machine: string | null; count: number; latest: number }>();
  for (const f of items) {
    const k = sessionKey(f), e = m.get(k);
    if (e) { e.count++; e.latest = Math.max(e.latest, f.created); } else m.set(k, { key: k, session: f.session, machine: f.machine, count: 1, latest: f.created });
  }
  return [...m.values()].sort((a, b) => b.latest - a.latest || (a.session ?? '').localeCompare(b.session ?? ''));
}

export const sinceText = (ts: number, now = Date.now()) => {
  const m = Math.floor((now - ts) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

export const expiresIn = (expires: number, now = Date.now()) => {
  const m = Math.round((expires - now) / 60_000);
  return m <= 0 ? 'expired' : m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
};

/**
 * Server-Sent Events fan-out for one user's open dashboard pages. The hub says "files changed"; every open page gets
 * `event: files` and reloads its list. A comment line every so often keeps proxies from closing an idle stream.
 */
export class EventFeed {
  private subs = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private enc = new TextEncoder();
  private max: number;
  constructor(max = 20) { this.max = max; }
  get size() { return this.subs.size; }

  subscribe(): ReadableStream<Uint8Array> {
    let me!: ReadableStreamDefaultController<Uint8Array>;
    return new ReadableStream<Uint8Array>({
      start: (c) => {
        me = c;
        this.subs.add(c);
        c.enqueue(this.enc.encode('retry: 3000\n: connected\n\n'));
        const [oldest] = this.subs;
        if (this.subs.size > this.max && oldest) { this.subs.delete(oldest); try { oldest.close(); } catch { /* gone */ } }
      },
      cancel: () => { this.subs.delete(me); },
    });
  }
  private send(text: string) {
    for (const c of [...this.subs]) { try { c.enqueue(this.enc.encode(text)); } catch { this.subs.delete(c); } }
  }
  broadcast() { this.send('event: files\ndata: 1\n\n'); }
  ping() { this.send(': ping\n\n'); }
}
