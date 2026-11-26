import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { commit, ensureBrain, setPushFailureSink } from '../src/tools/memory.ts';
import { writeFileSync } from 'node:fs';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('brain push: edits are batched into one delayed push; a failed push is retried and never blocks a write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brainpush-'));
  const remote = join(root, 'remote.git'), dir = join(root, 'brain');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const db = new Db(':memory:');
  setPushFailureSink((m) => db.addPushFailure(m));
  await ensureBrain(dir);
  sh(dir, 'remote', 'add', 'origin', remote);
  process.env.BRAIN_PUSH = '1';
  process.env.BRAIN_PUSH_DELAY_S = '1';
  try {
    sh(dir, 'branch', '-M', 'main'); sh(dir, 'config', 'push.autoSetupRemote', 'true');
    // remote broken: writes still succeed, push fails quietly
    sh(dir, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    writeFileSync(join(dir, 'a.md'), '1'); await commit(dir, 'one');
    writeFileSync(join(dir, 'b.md'), '2'); await commit(dir, 'two');
    await sleep(1400); // first push attempt fails
    sh(dir, 'remote', 'set-url', 'origin', remote);
    await sleep(1500); // retried tick succeeds, both commits in one push
    assert.equal(sh(remote, 'log', '--oneline', 'main').split('\n').length, 3); // init + one + two
    assert.ok((db.db.prepare('SELECT COUNT(*) n FROM push_failures').get() as { n: number }).n >= 1, 'failure was logged');
    db.db.prepare('UPDATE push_failures SET ts = ?').run(Date.now() - 8 * 86400_000);
    db.pruneEvents();
    assert.equal((db.db.prepare('SELECT COUNT(*) n FROM push_failures').get() as { n: number }).n, 0, 'older than 7 days is pruned');
    // nothing pending: no further push; a new change is pushed after the delay
    writeFileSync(join(dir, 'c.md'), '3'); await commit(dir, 'three');
    assert.equal(sh(remote, 'log', '--oneline', 'main').split('\n').length, 3, 'not pushed immediately');
    await sleep(1500);
    assert.equal(sh(remote, 'log', '--oneline', 'main').split('\n').length, 4);
  } finally { delete process.env.BRAIN_PUSH; delete process.env.BRAIN_PUSH_DELAY_S; }
});
