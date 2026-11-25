// The hub's FileTransfers wired straight to the worker's Download: proves both ends speak the same frames,
// that bytes arrive intact (also with a slow reader, i.e. backpressure), ranges resume, and revoke cuts the stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/db.ts';
import { FileTransfers, limits, revoke, share } from '../../src/tools/files.ts';
import { Download, decodeFrame } from '../src/files.ts';

const setup = (bytes: number) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-')));
  const data = randomBytes(bytes);
  writeFileSync(join(root, 'f.bin'), data);
  const lim = limits({ FILE_SHARE_ROOTS: root } as never);
  const ctx = { cfg: {}, db: new Db(':memory:') } as never;
  const s = share(ctx, join(root, 'f.bin'), 30, Date.now(), lim, 'https://orch.example');
  return { data, ctx, lim, shareId: s.id };
};

/** One download over a fake socket: agent frames go to the Download, the Download's acks/cancels go to the agent. */
const connect = (ctx: never, lim: ReturnType<typeof limits>, shareId: string, req: { range?: string } = {}) => {
  const id = crypto.randomUUID();
  const ft: FileTransfers = new FileTransfers(ctx, {
    send: (d) => {
      if (typeof d === 'string') {
        const m = JSON.parse(d);
        if (m.type === 'file-head') dl.onHead({ status: m.status, headers: m.headers, message: m.message });
        else if (m.type === 'file-end') dl.onEnd();
        else if (m.type === 'file-error') dl.fail(m.message);
      } else {
        const f = decodeFrame(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
        assert.ok(f && f.id === id);
        dl.onChunk(f.data);
      }
    },
  }, () => lim);
  const dl = new Download(id, (m) => queueMicrotask(() => void ft.onMessage(m as never)));
  void ft.onMessage({ type: 'file', id, share: shareId, range: req.range });
  return dl;
};

const readAll = async (dl: Download, delayMs = 0) => {
  const parts: Uint8Array[] = [];
  const reader = dl.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return Buffer.concat(parts);
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('relay: a 9 MB file arrives intact through head, frames, acks and end', async () => {
  const { data, ctx, lim, shareId } = setup(9 * 1024 * 1024 + 123);
  const dl = connect(ctx as never, lim, shareId);
  const head = await dl.head;
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(data.length));
  assert.equal(sha(await readAll(dl)), sha(data));
});

test('relay: a slow reader still gets every byte (the window holds the agent back)', async () => {
  const { data, ctx, lim, shareId } = setup(6 * 1024 * 1024);
  const dl = connect(ctx as never, lim, shareId);
  await dl.head;
  assert.equal(sha(await readAll(dl, 5)), sha(data));
});

test('relay: Range resumes mid-file with 206 and the right bytes', async () => {
  const { data, ctx, lim, shareId } = setup(1_000_000);
  const dl = connect(ctx as never, lim, shareId, { range: 'bytes=600000-' });
  const head = await dl.head;
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-range'], `bytes 600000-999999/1000000`);
  assert.deepEqual(await readAll(dl), data.subarray(600000));
});

test('relay: unknown share is a 404 head with a message and no body', async () => {
  const { ctx, lim } = setup(10);
  const dl = connect(ctx as never, lim, 'does-not-exist-xxxxxxxx');
  const head = await dl.head;
  assert.equal(head.status, 404);
  assert.match(head.message ?? '', /not shared/);
});

test('relay: revoke while downloading errors the body stream', async () => {
  const { ctx, lim, shareId } = setup(20 * 1024 * 1024);
  const dl = connect(ctx as never, lim, shareId);
  await dl.head;
  const reader = dl.body.getReader();
  await reader.read();
  revoke(ctx as never, shareId);
  await assert.rejects(async () => { for (;;) { const r = await reader.read(); if (r.done) return; await new Promise((x) => setTimeout(x, 2)); } }, /revoked/);
});
