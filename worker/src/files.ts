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

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'content-disposition', 'last-modified'];

/** Only known headers from the agent pass through; the security headers are ours. */
export function responseHeaders(from: Record<string, string>): Headers {
  const h = new Headers();
  for (const k of PASS) if (typeof from[k] === 'string') h.set(k, from[k]);
  h.set('cache-control', 'private, no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('content-security-policy', "default-src 'none'; sandbox");
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

export const expiresIn = (expires: number, now = Date.now()) => {
  const m = Math.round((expires - now) / 60_000);
  return m <= 0 ? 'expired' : m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
};
