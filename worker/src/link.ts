// The agent link: always routes to the newest live agent socket. Pure (no Cloudflare imports) so node can test it.
export type Result = { content: unknown[]; isError?: boolean; [k: string]: unknown };
export interface Sock { readyState: number; send(data: string): void }
const OPEN = 1;

const fail = (summary: string): Result => ({ content: [{ type: 'text', text: JSON.stringify({ summary }) }], isError: true });
export const OFFLINE = 'Your orchestrator hub is offline or reconnecting. Retry in a few seconds.';

export class AgentLink {
  private pending = new Map<string, { resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout>; sock: Sock }>();
  /** `socks` lists the agent sockets (any order); `since` says when each connected, so the newest wins. */
  private socks: () => Sock[];
  private since: (s: Sock) => number;
  constructor(socks: () => Sock[], since: (s: Sock) => number) { this.socks = socks; this.since = since; }

  /** Open sockets, newest first. A closed or closing one is never used. */
  live(): Sock[] {
    return this.socks().filter((s) => s.readyState === OPEN).sort((a, b) => this.since(b) - this.since(a));
  }

  /** Send on the newest live socket; one that throws is skipped. Returns the socket used, or null when none took it. */
  send(msg: object): Sock | null {
    const data = JSON.stringify(msg);
    for (const s of this.live()) {
      try { s.send(data); return s; } catch { /* closed under us: try the next */ }
    }
    return null;
  }

  /** Relay one call. null = no live socket at all; otherwise the agent's result or a clear error (never a throw). */
  call(name: string, args: unknown, timeoutMs: number, longMs: number): Promise<Result | null> {
    const id = crypto.randomUUID();
    return new Promise<Result | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fail(timeoutMs === longMs ? 'Your orchestrator agent did not answer within 6 minutes.' : 'Your orchestrator agent did not answer in time.'));
      }, timeoutMs);
      const sock = this.send({ type: 'call', id, name, args });
      if (!sock) { clearTimeout(timer); resolve(this.live().length || this.socks().length ? fail(OFFLINE) : null); return; }
      this.pending.set(id, { resolve, timer, sock });
    });
  }

  result(id: string, result: Result | undefined) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(result && Array.isArray(result.content) ? result : { content: [{ type: 'text', text: 'Malformed agent result.' }], isError: true });
  }

  /** A socket is gone: the calls waiting on it will never be answered, so say so now instead of after the timeout. */
  closed(sock: Sock) {
    for (const [id, p] of this.pending) {
      if (p.sock !== sock) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(fail('The connection to your orchestrator hub dropped while this call was running. Retry in a few seconds.'));
    }
  }
}
