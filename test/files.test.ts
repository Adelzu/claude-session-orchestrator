import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { UserError } from '../src/config.ts';
import type { Ctx } from '../src/tools/common.ts';
import { FileTransfers, WINDOW_BYTES, checkPath, cleanTag, inlineType, limits, list, open, parseRange, revoke, revokeGroup, safeName, setFilesListener, share, baseUrl, type Limits } from '../src/tools/files.ts';

const BASE = 'https://orch.example';
const setup = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'files-')));
  const root = join(dir, 'root'); const out = join(dir, 'outside');
  mkdirSync(root); mkdirSync(out); mkdirSync(join(root, '.git')); mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.txt'), '0123456789');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, '.git', 'config'), 'x');
  writeFileSync(join(root, 'sub', 'b.bin'), Buffer.alloc(10));
  writeFileSync(join(out, 'secret.txt'), 'nope');
  const lim: Limits = limits({ FILE_SHARE_ROOTS: root } as never);
  const ctx = { cfg: {}, db: new Db(':memory:') } as unknown as Ctx;
  return { dir, root, out, lim, ctx };
};
const refuses = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof UserError && re.test(e.message));

test('limits: no roots configured means nothing can be shared', () => {
  const { root } = setup();
  assert.deepEqual(limits({} as never).roots, []);
  refuses(() => checkPath(join(root, 'a.txt'), limits({} as never)), /FILE_SHARE_ROOTS/);
});

test('checkPath: roots only, no dotfiles, no folders, size cap, symlinks resolved', () => {
  const { root, out, lim } = setup();
  assert.equal(checkPath(join(root, 'a.txt'), lim).size, 10);
  assert.equal(checkPath(join(root, 'sub', 'b.bin'), lim).size, 10);
  refuses(() => checkPath(join(out, 'secret.txt'), lim), /outside/);
  refuses(() => checkPath(join(root, '..', 'outside', 'secret.txt'), lim), /outside/);
  refuses(() => checkPath(join(root, '.env'), lim), /Dotfiles/);
  refuses(() => checkPath(join(root, '.git', 'config'), lim), /Dotfiles/);
  refuses(() => checkPath(join(root, 'sub'), lim), /regular/);
  refuses(() => checkPath('relative/a.txt', lim), /absolute/);
  refuses(() => checkPath(join(root, 'missing'), lim), /No such file/);
  refuses(() => checkPath(join(root, 'a.txt'), { ...lim, maxBytes: 5 }), /limit/);
  // A symlink inside the root that points outside is refused; one pointing at a dotfile is refused.
  symlinkSync(join(out, 'secret.txt'), join(root, 'link-out'));
  symlinkSync(join(root, '.env'), join(root, 'link-env'));
  refuses(() => checkPath(join(root, 'link-out'), lim), /outside/);
  refuses(() => checkPath(join(root, 'link-env'), lim), /Dotfiles/);
});

test('safeName strips path parts and unsafe characters', () => {
  assert.equal(safeName('/x/y/report.pdf'), 'report.pdf');
  assert.equal(safeName('a"b\r\nc.txt'), 'a_b__c.txt');
  assert.equal(safeName('/'), 'file');
});

test('baseUrl comes from ORCH_CLOUD_URL', () => {
  assert.equal(baseUrl({ ORCH_CLOUD_URL: 'wss://orch.example/agent' } as never), BASE);
  assert.equal(baseUrl({} as never), null);
});

test('share: ttl bounds, default, list, revoke, expiry', () => {
  const { root, lim, ctx } = setup();
  const now = 1_000_000;
  refuses(() => share(ctx, join(root, 'a.txt'), 0, now, lim, BASE), /ttl_minutes/);
  refuses(() => share(ctx, join(root, 'a.txt'), 1441, now, lim, BASE), /ttl_minutes/);
  refuses(() => share(ctx, join(root, 'a.txt'), 30, now, lim, null), /agent mode/);
  refuses(() => share(ctx, join(root, '.env'), 30, now, lim, BASE), /Dotfiles/);
  const s = share(ctx, join(root, 'a.txt'), undefined, now, lim, BASE);
  assert.equal(s.expires, now + 30 * 60_000);
  assert.match(s.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(s.url, `${BASE}/f/${s.id}/a.txt`);
  const max = share(ctx, join(root, 'sub', 'b.bin'), 1440, now, lim, BASE);
  assert.equal(max.expires, now + 24 * 3600_000);
  assert.equal(list(ctx, now, BASE).length, 2);
  assert.equal(list(ctx, now + 31 * 60_000, BASE).length, 1); // the 30 min one has expired
  assert.equal(revoke(ctx, s.id), true);
  assert.equal(revoke(ctx, s.id), false);
  assert.equal(list(ctx, now, BASE).length, 1);
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=5-99', 10), { start: 5, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 10), 'full');
  assert.equal(parseRange('bytes=0-1,3-4', 10), 'full');
  assert.equal(parseRange('items=0-1', 10), 'full');
  assert.equal(parseRange(undefined, 10), 'full');
});

const drain = async (o: ReturnType<typeof open>) => {
  const parts: Buffer[] = [];
  if (o.stream) for await (const c of o.stream) parts.push(c as Buffer);
  return Buffer.concat(parts).toString();
};

test('open: full, range, resume, 416, head, headers', async () => {
  const { root, lim, ctx } = setup();
  const now = Date.now();
  const s = share(ctx, join(root, 'a.txt'), 30, now, lim, BASE);
  const full = open(ctx, s.id, {}, now, lim);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'application/octet-stream');
  assert.equal(full.headers['content-length'], '10');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.match(full.headers['content-disposition']!, /^attachment; filename="a\.txt"/);
  assert.equal(await drain(full), '0123456789');
  const part = open(ctx, s.id, { range: 'bytes=3-5' }, now, lim);
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 3-5/10');
  assert.equal(part.headers['content-length'], '3');
  assert.equal(await drain(part), '345');
  assert.equal(await drain(open(ctx, s.id, { range: 'bytes=7-' }, now, lim)), '789'); // resume
  const bad = open(ctx, s.id, { range: 'bytes=50-' }, now, lim);
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */10');
  const head = open(ctx, s.id, { head: true }, now, lim);
  assert.equal(head.status, 200);
  assert.equal(head.stream, undefined);
  // If-Range with a stale validator: the whole file again.
  const stale = open(ctx, s.id, { range: 'bytes=3-5', ifRange: '"old"' }, now, lim);
  assert.equal(stale.status, 200);
  stale.close?.();
  const fresh = open(ctx, s.id, { range: 'bytes=3-5', ifRange: full.headers.etag }, now, lim);
  assert.equal(fresh.status, 206);
  fresh.close?.();
});

test('open: unknown, expired, revoked and later-invalid shares never serve', async () => {
  const { root, out, lim, ctx } = setup();
  const now = Date.now();
  assert.equal(open(ctx, 'nope', {}, now, lim).status, 404);
  const s = share(ctx, join(root, 'a.txt'), 1, now, lim, BASE);
  assert.equal(open(ctx, s.id, {}, now + 61_000, lim).status, 404); // expired
  const r = share(ctx, join(root, 'a.txt'), 5, now, lim, BASE);
  revoke(ctx, r.id);
  assert.equal(open(ctx, r.id, {}, now, lim).status, 404);
  // The file is replaced by a link to something outside after sharing.
  const l = share(ctx, join(root, 'sub', 'b.bin'), 5, now, lim, BASE);
  const o = open(ctx, l.id, {}, now, { ...lim, roots: [out] });
  assert.equal(o.status, 403);
  assert.equal(o.stream, undefined);
  // Size cap is enforced again at download time.
  assert.equal(open(ctx, l.id, {}, now, { ...lim, maxBytes: 1 }).status, 403);
});

// ---- the agent socket protocol ----
const id36 = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const fakePeer = () => {
  const frames: (string | Uint8Array)[] = [];
  const json = () => frames.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f));
  const body = () => Buffer.concat(frames.filter((f): f is Uint8Array => typeof f !== 'string').map((f) => Buffer.from(f).subarray(36)));
  return { frames, json, body, send: (d: string | Uint8Array) => { frames.push(d); } };
};
const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(cond(), 'timed out'); };

test('FileTransfers: head, binary frames carry the request id, end', async () => {
  const { root, lim, ctx } = setup();
  const s = share(ctx, join(root, 'a.txt'), 30, Date.now(), lim, BASE);
  const peer = fakePeer();
  const ft = new FileTransfers(ctx, peer, () => lim);
  await ft.onMessage({ type: 'file', id: id36(1), share: s.id, range: 'bytes=2-4' });
  const [head, end] = peer.json();
  assert.equal(head.type, 'file-head'); assert.equal(head.status, 206); assert.equal(head.headers['content-range'], 'bytes 2-4/10');
  assert.equal(end.type, 'file-end');
  assert.equal(Buffer.from(peer.frames[1] as Uint8Array).subarray(0, 36).toString(), id36(1));
  assert.equal(peer.body().toString(), '234');
  // Unknown share: a head with 404 and no body.
  const p2 = fakePeer();
  await new FileTransfers(ctx, p2, () => lim).onMessage({ type: 'file', id: id36(2), share: 'nope' });
  assert.equal(p2.json()[0].status, 404);
  assert.equal(p2.body().length, 0);
  // HEAD request: head only.
  const p3 = fakePeer();
  await new FileTransfers(ctx, p3, () => lim).onMessage({ type: 'file', id: id36(3), share: s.id, head: true });
  assert.equal(p3.body().length, 0);
});

test('FileTransfers: sends at most the window before an ack, then continues', async () => {
  const { root, lim, ctx } = setup();
  const size = WINDOW_BYTES + 1024 * 1024;
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(size, 7));
  const s = share(ctx, join(root, 'big.bin'), 30, Date.now(), lim, BASE);
  const peer = fakePeer();
  const ft = new FileTransfers(ctx, peer, () => lim);
  const done = ft.onMessage({ type: 'file', id: id36(4), share: s.id });
  await until(() => peer.body().length >= WINDOW_BYTES);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(peer.body().length, WINDOW_BYTES, 'stalls at the window until acked');
  assert.ok(!peer.json().some((m) => m.type === 'file-end'));
  await ft.onMessage({ type: 'ack', id: id36(4), bytes: WINDOW_BYTES });
  await done;
  assert.equal(peer.body().length, size);
  assert.equal(peer.json().at(-1).type, 'file-end');
});

test('FileTransfers: cancel stops sending; revoke cuts a running download; closeAll stops everything', async () => {
  const { root, lim, ctx } = setup();
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(WINDOW_BYTES * 2, 1));
  const a = share(ctx, join(root, 'big.bin'), 30, Date.now(), lim, BASE);
  const p1 = fakePeer(); const f1 = new FileTransfers(ctx, p1, () => lim);
  const d1 = f1.onMessage({ type: 'file', id: id36(5), share: a.id });
  await until(() => p1.body().length >= WINDOW_BYTES);
  await f1.onMessage({ type: 'cancel', id: id36(5) });
  await d1;
  assert.ok(p1.body().length <= WINDOW_BYTES + 512 * 1024);
  assert.ok(!p1.json().some((m) => m.type === 'file-end'));

  const p2 = fakePeer(); const f2 = new FileTransfers(ctx, p2, () => lim);
  const d2 = f2.onMessage({ type: 'file', id: id36(6), share: a.id });
  await until(() => p2.body().length >= WINDOW_BYTES);
  revoke(ctx, a.id);
  await d2;
  assert.equal(p2.json().at(-1).type, 'file-error');

  const b = share(ctx, join(root, 'big.bin'), 30, Date.now(), lim, BASE);
  const p3 = fakePeer(); const f3 = new FileTransfers(ctx, p3, () => lim);
  const d3 = f3.onMessage({ type: 'file', id: id36(7), share: b.id });
  await until(() => p3.body().length >= WINDOW_BYTES);
  f3.closeAll();
  await d3;
  assert.ok(!p3.json().some((m) => m.type === 'file-end'));
});

// ---- inline viewing, groups ----
test('inlineType: images, PDF and plain text only; never HTML or SVG', () => {
  assert.equal(inlineType('a.PNG'), 'image/png');
  assert.equal(inlineType('a.jpeg'), 'image/jpeg');
  assert.equal(inlineType('a.pdf'), 'application/pdf');
  assert.equal(inlineType('notes.txt'), 'text/plain; charset=utf-8');
  for (const bad of ['a.html', 'a.htm', 'a.svg', 'a.svgz', 'a.xml', 'a.js', 'a.xhtml', 'a.exe', 'a', 'a.png.html']) assert.equal(inlineType(bad), undefined, bad);
});

test('open inline: safe types get inline + their own type; unsafe types stay downloads', async () => {
  const { root, lim, ctx } = setup();
  writeFileSync(join(root, 'p.png'), 'not really a png');
  writeFileSync(join(root, 'page.html'), '<script>alert(1)</script>');
  writeFileSync(join(root, 'pic.svg'), '<svg onload="alert(1)"/>');
  writeFileSync(join(root, 'n.txt'), 'hello');
  const now = Date.now();
  const png = share(ctx, join(root, 'p.png'), 30, now, lim, BASE);
  const html = share(ctx, join(root, 'page.html'), 30, now, lim, BASE);
  const svg = share(ctx, join(root, 'pic.svg'), 30, now, lim, BASE);
  const txt = share(ctx, join(root, 'n.txt'), 30, now, lim, BASE);
  const a = open(ctx, png.id, { inline: true }, now, lim);
  assert.equal(a.headers['content-type'], 'image/png');
  assert.match(a.headers['content-disposition']!, /^inline; filename="p\.png"/);
  a.close?.();
  const t = open(ctx, txt.id, { inline: true }, now, lim);
  assert.equal(t.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(t.headers['content-disposition']!, /^inline/);
  t.close?.();
  for (const id of [html.id, svg.id]) {
    const o = open(ctx, id, { inline: true }, now, lim);
    assert.equal(o.headers['content-type'], 'application/octet-stream');
    assert.match(o.headers['content-disposition']!, /^attachment/);
    o.close?.();
  }
  // Without the inline flag even an image downloads.
  const d = open(ctx, png.id, {}, now, lim);
  assert.match(d.headers['content-disposition']!, /^attachment/);
  assert.equal(d.headers['content-type'], 'application/octet-stream');
  d.close?.();
});

test('groups and labels: validated, listed, same file again updates instead of duplicating', () => {
  const { root, lim, ctx } = setup();
  const now = 5_000_000;
  const a = share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { group: 'watermark-samples-1', label: '1920x1080' });
  const b = share(ctx, join(root, 'sub', 'b.bin'), 30, now, lim, BASE, { group: 'watermark-samples-1', label: '2560x1440' });
  const l = list(ctx, now, BASE);
  assert.deepEqual(l.map((f) => [f.group, f.label]).sort(), [['watermark-samples-1', '1920x1080'], ['watermark-samples-1', '2560x1440']]);
  const again = share(ctx, join(root, 'a.txt'), 120, now + 1000, lim, BASE, { group: 'other', label: 'x' });
  assert.equal(again.id, a.id);
  assert.equal(list(ctx, now, BASE).length, 2);
  assert.equal(list(ctx, now, BASE).find((f) => f.id === a.id)?.group, 'other');
  assert.equal(list(ctx, now, BASE).find((f) => f.id === a.id)?.expires, now + 1000 + 120 * 60_000);
  refuses(() => share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { group: 'bad/group' }), /group/);
  refuses(() => share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { group: 'x'.repeat(61) }), /group/);
  refuses(() => share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { label: '1920x1080' }), /needs a group/);
  assert.equal(cleanTag('  ', 'group', 60), null);
  assert.equal(cleanTag('ok name-1.2', 'group', 60), 'ok name-1.2');
  assert.ok(b.id);
});

test('revokeGroup revokes only that group', () => {
  const { root, lim, ctx } = setup();
  const now = 7_000_000;
  share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { group: 'g1' });
  share(ctx, join(root, 'sub', 'b.bin'), 30, now, lim, BASE, { group: 'g2' });
  assert.equal(revokeGroup(ctx, 'g1', now), 1);
  assert.equal(revokeGroup(ctx, 'g1', now), 0);
  assert.deepEqual(list(ctx, now, BASE).map((f) => f.group), ['g2']);
});

test('files-changed notifier: once per burst, on share, update and revoke; silent for a failed revoke', async () => {
  const { root, lim, ctx } = setup();
  let n = 0;
  setFilesListener(() => { n++; });
  const wait = () => new Promise((r) => setTimeout(r, 260));
  try {
    const now = Date.now();
    const a = share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { group: 'g' });
    share(ctx, join(root, 'sub', 'b.bin'), 30, now, lim, BASE, { group: 'g' });
    await wait();
    assert.equal(n, 1, 'two shares in a burst are one event');
    share(ctx, join(root, 'a.txt'), 30, now, lim, BASE, { group: 'h' }); // update
    await wait();
    assert.equal(n, 2);
    assert.equal(revoke(ctx, 'nope-nope-nope'), false);
    await wait();
    assert.equal(n, 2, 'nothing changed, nothing sent');
    revoke(ctx, a.id);
    await wait();
    assert.equal(n, 3);
    revokeGroup(ctx, 'g', now);
    await wait();
    assert.equal(n, 4);
  } finally { setFilesListener(null); }
});

test('who shared it and when: stored from the caller, listed, refreshed on re-share', () => {
  const { root, lim, ctx } = setup();
  const t0 = 9_000_000;
  const a = share(ctx, join(root, 'a.txt'), 30, t0, lim, BASE, { by: { session: 'cc-filetest', machine: 'hub' } });
  share(ctx, join(root, 'sub', 'b.bin'), 30, t0 + 5, lim, BASE); // via the main endpoint: no caller
  const l = list(ctx, t0 + 10, BASE);
  assert.deepEqual(l.find((f) => f.id === a.id) && [l.find((f) => f.id === a.id)!.session, l.find((f) => f.id === a.id)!.machine, l.find((f) => f.id === a.id)!.created], ['cc-filetest', 'hub', t0]);
  const b = l.find((f) => f.name === 'b.bin')!;
  assert.deepEqual([b.session, b.machine, b.created], [null, null, t0 + 5]);
  share(ctx, join(root, 'a.txt'), 30, t0 + 1000, lim, BASE, { by: { session: 'cc-other', machine: 'hub' } });
  const again = list(ctx, t0 + 1000, BASE).find((f) => f.id === a.id)!;
  assert.deepEqual([again.session, again.created], ['cc-other', t0 + 1000]);
});
