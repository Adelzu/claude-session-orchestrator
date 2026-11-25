import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Download, decodeFrame, expiresIn, humanSize, parseFilePath, responseHeaders } from '../src/files.ts';

const ID = '11111111-2222-3333-4444-555555555555';
const frame = (id: string, data: number[]) => { const b = new Uint8Array(36 + data.length); b.set(new TextEncoder().encode(id)); b.set(data, 36); return b.buffer; };

test('parseFilePath: only /f/<id>[/<name>]', () => {
  assert.equal(parseFilePath('/f/abcdefghijklmnopqrstuv/report.pdf'), 'abcdefghijklmnopqrstuv');
  assert.equal(parseFilePath('/f/abcdefghijklmnopqrstuv'), 'abcdefghijklmnopqrstuv');
  assert.equal(parseFilePath('/f/short/x'), null);
  assert.equal(parseFilePath('/f/abcdefghijklmnopqrstuv/a/b'), null);
  assert.equal(parseFilePath('/files/abcdefghijklmnopqrstuv'), null);
  assert.equal(parseFilePath('/f/../../etc/passwdaaaaaaaaaaa'), null);
});

test('decodeFrame: request id prefix, data after it', () => {
  const f = decodeFrame(frame(ID, [1, 2, 3]))!;
  assert.equal(f.id, ID);
  assert.deepEqual([...f.data], [1, 2, 3]);
  assert.equal(decodeFrame(new ArrayBuffer(10)), null);
  assert.equal(decodeFrame(frame('x'.repeat(36), [1])), null);
});

test('responseHeaders: whitelist plus security headers', () => {
  const h = responseHeaders({ 'content-type': 'application/octet-stream', 'content-length': '5', 'set-cookie': 'evil=1', location: 'https://evil', 'content-disposition': 'attachment; filename="a"' });
  assert.equal(h.get('content-length'), '5');
  assert.equal(h.get('set-cookie'), null);
  assert.equal(h.get('location'), null);
  assert.equal(h.get('cache-control'), 'private, no-store');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.match(h.get('content-security-policy')!, /sandbox/);
});

test('humanSize and expiresIn', () => {
  assert.equal(humanSize(10), '1 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(humanSize(3 * 1024 ** 3), '3.0 GB');
  assert.equal(expiresIn(1000 + 28 * 60_000, 1000), '28 min');
  assert.equal(expiresIn(1000 + 120 * 60_000, 1000), '2 h');
  assert.equal(expiresIn(500, 1000), 'expired');
});

test('Download: head, chunks in order, end closes the body', async () => {
  const sent: any[] = [];
  const d = new Download(ID, (m) => sent.push(m));
  d.onHead({ status: 200, headers: { 'content-length': '4' } });
  assert.equal((await d.head).status, 200);
  d.onChunk(new Uint8Array([1, 2])); d.onChunk(new Uint8Array([3, 4])); d.onEnd();
  const got: number[] = [];
  for await (const c of d.body) got.push(...c);
  assert.deepEqual(got, [1, 2, 3, 4]);
});

test('Download: acks what it received, but only as the reader makes room (backpressure)', async () => {
  const sent: any[] = [];
  const d = new Download(ID, (m) => sent.push(m), { highWaterMark: 4 });
  d.onHead({ status: 200, headers: {} });
  const acks = () => sent.filter((m) => m.type === 'ack');
  d.onChunk(new Uint8Array(4)); // fills the queue: pull is not called, no ack yet
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(acks().length, 0);
  const reader = d.body.getReader();
  await reader.read(); // the client took 4 bytes: room again
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(acks().at(-1)?.bytes, 4);
  assert.equal(acks().at(-1)?.id, ID);
  d.onEnd(); reader.releaseLock();
});

test('Download: client abort tells the agent to cancel; later chunks are ignored', async () => {
  const sent: any[] = [];
  const d = new Download(ID, (m) => sent.push(m));
  let closed = 0; d.onClosed = () => closed++;
  d.onHead({ status: 200, headers: {} });
  await d.body.cancel();
  assert.ok(sent.some((m) => m.type === 'cancel' && m.id === ID));
  assert.equal(closed, 1);
  d.onChunk(new Uint8Array(3)); // must not throw
  d.onEnd();
});

test('Download: failure before the head gives an error head; after it the body errors', async () => {
  const d1 = new Download(ID, () => {});
  d1.fail('The agent disconnected.');
  const h = await d1.head;
  assert.equal(h.status, 502);
  assert.equal(h.message, 'The agent disconnected.');
  const d2 = new Download(ID, () => {});
  d2.onHead({ status: 200, headers: {} });
  d2.onChunk(new Uint8Array([9]));
  d2.fail('The share was revoked.');
  await assert.rejects(async () => { for await (const _ of d2.body) { /* drain */ } }, /revoked/);
});

test('Download: an agent that goes quiet times out with a 504 and a cancel', async () => {
  const sent: any[] = [];
  const d = new Download(ID, (m) => sent.push(m), { idleMs: 20 });
  d.onHead({ status: 200, headers: {} });
  d.onChunk(new Uint8Array(2));
  const reader = d.body.getReader();
  await reader.read(); // consumed and acked: the agent owes data now
  await assert.rejects(reader.read(), /stopped sending/);
  assert.ok(sent.some((m) => m.type === 'cancel'));
});

test('Download: no head within the wait gives a 504', async () => {
  const d = new Download(ID, () => {}, { idleMs: 10 });
  // the first wait is fixed at 15 s; failing it directly is what the timer does
  d.fail('The agent stopped sending.', 504);
  assert.equal((await d.head).status, 504);
});
