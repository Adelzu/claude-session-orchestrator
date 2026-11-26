import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { ingest, waitForEvent } from '../src/tools/events.ts';

const hub = { id: 'hub' };
const mk = () => {
  const db = new Db(':memory:');
  db.upsertSession({ name: 'cc-a', machine: 'hub', project: 'a', status: 'working', remote_control: 0 });
  return { db, ctx: { db, cfg: { machines: [hub], projects: [] } } as never };
};

test('no cursor: only events from now on; one event at a time, oldest first, cursor advances', async () => {
  const { db, ctx } = mk();
  db.setStatus('cc-a', 'waiting_input', 'old news'); // before the first wait: must not be delivered
  const first = waitForEvent(ctx, undefined, 5);
  db.setStatus('cc-a', 'working');
  db.setStatus('cc-a', 'waiting_approval', 'Allow Bash?');
  db.setStatus('cc-a', 'idle', 'done');
  const a = await first;
  assert.equal(a.event!.type, 'approval');
  const b = await waitForEvent(ctx, a.cursor, 1);
  assert.equal(b.event!.type, 'idle');
  assert.ok(b.cursor > a.cursor);
  const c = await waitForEvent(ctx, b.cursor, 0);
  assert.equal(c.event, null);
  assert.equal(c.cursor, b.cursor, 'timeout keeps the cursor');
});

test('resume from an old cursor after a reconnect: nothing missed, nothing twice', async () => {
  const { db, ctx } = mk();
  const start = db.lastEventId();
  db.setStatus('cc-a', 'idle', 'one');
  db.setStatus('cc-a', 'working');
  db.setStatus('cc-a', 'waiting_input', 'two');
  const got: string[] = [];
  let cur = start;
  for (;;) { const r = await waitForEvent(ctx, cur, 0); if (!r.event) break; got.push(r.event.type); cur = r.cursor; }
  assert.deepEqual(got, ['idle', 'waiting_input']);
  // the log is on disk, so a new reader with the same cursor sees only what came after
  db.setStatus('cc-a', 'stopped');
  assert.equal((await waitForEvent(ctx, cur, 0)).event!.type, 'stopped');
});

test('a waiting caller wakes the moment an event arrives', async () => {
  const { db, ctx } = mk();
  const t = Date.now();
  const w = waitForEvent(ctx, undefined, 30);
  setTimeout(() => db.setStatus('cc-a', 'idle'), 50);
  assert.equal((await w).event!.type, 'idle');
  assert.ok(Date.now() - t < 2000);
});

test('hooks: Stop and Notification emit, SessionEnd after a stop is not a second event', async () => {
  const { db, ctx } = mk();
  const cur = db.lastEventId();
  assert.equal(ingest(ctx, 'cc-a', 'hub', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), 204);
  assert.equal(ingest(ctx, 'cc-a', 'hub', { hook_event_name: 'Stop' }), 204);
  db.setStatus('cc-a', 'stopped', null, 'session_stop graceful');
  ingest(ctx, 'cc-a', 'hub', { hook_event_name: 'SessionEnd' });
  const types: string[] = []; let c = cur;
  for (;;) { const r = await waitForEvent(ctx, c, 0); if (!r.event) break; types.push(r.event.type); c = r.cursor; }
  assert.deepEqual(types, ['approval', 'idle', 'stopped']);
});

test('crash and background jobs are events; the same event twice within 5 s is one', async () => {
  const { db, ctx } = mk();
  const cur = db.lastEventId();
  db.setStatus('cc-a', 'stopped', null, 'refresh: tmux session is gone');
  db.addJob('j1', 'coder', 'build it'); db.finishJob('j1', 'done', 'ok');
  db.addJob('j2', 'coder', 'break it'); db.finishJob('j2', 'failed', 'exit 1');
  db.setStatus('cc-a', 'idle', null, 'x', true); db.setStatus('cc-a', 'idle', null, 'y', true);
  const out: [string, string][] = []; let c = cur;
  for (;;) { const r = await waitForEvent(ctx, c, 0); if (!r.event) break; out.push([r.event.type, r.event.session]); c = r.cursor; }
  assert.deepEqual(out, [['crashed', 'cc-a'], ['job_done', 'job:coder'], ['job_failed', 'job:coder'], ['idle', 'cc-a']]);
});

test('retention: old events are pruned', () => {
  const { db } = mk();
  db.db.prepare(`INSERT INTO events (session, hook, status, ts, type, summary) VALUES ('cc-a','emit','idle', ?, 'idle', 'old')`).run(Date.now() - 8 * 86400_000);
  db.pruneEvents();
  assert.equal(db.db.prepare(`SELECT COUNT(*) n FROM events WHERE summary = 'old'`).get()!.n, 0);
});

test('entry tools carry the watch guidance only while nobody is watching events_wait', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { mcpServer } = await import('../src/server.ts');
  const { WATCH_GUIDANCE } = await import('../src/tools/common.ts');
  const { db, ctx } = mk();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([mcpServer(ctx).connect(a), c.connect(b)]);
  const call = async (name: string, args = {}) => JSON.parse(((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
  const first = await call('events_pending');
  assert.equal(first.guidance, WATCH_GUIDANCE);
  assert.ok(!first.summary.includes('events_wait'), 'never in the spoken summary');
  await call('events_wait', { timeout_seconds: 0 });
  assert.equal((await call('events_pending')).guidance, undefined, 'already watching: no second nudge');
  assert.equal((await call('machine_list')).guidance, undefined, 'other tools never carry it');
  db.lastWaitAt = Date.now() - 300_000;
  assert.equal((await call('events_pending')).guidance, WATCH_GUIDANCE, 'a lapsed watch is nudged again');
});
