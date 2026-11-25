import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLoginPath, normalizeLoginPath, publicRoute, resolveSettings, validateChange } from '../src/settings.ts';

test('normalizeLoginPath: one safe segment, 8 to 64 chars, never a reserved name', () => {
  assert.equal(normalizeLoginPath('/abc-12345'), '/abc-12345');
  assert.equal(normalizeLoginPath('abc-12345'), '/abc-12345');
  assert.equal(normalizeLoginPath(' //abc-12345 '), '/abc-12345');
  for (const bad of ['', '/short', '/has/slash/inside', '/with space 123', '/dashboard', '/Dashboard', '/callback', '/authorize', '/a'.repeat(70), '/../etc/passwd', undefined, null]) {
    assert.equal(normalizeLoginPath(bad as never), null, String(bad));
  }
});

test('generateLoginPath makes valid, different paths', () => {
  const a = generateLoginPath(), b = generateLoginPath();
  assert.equal(normalizeLoginPath(a), a);
  assert.notEqual(a, b);
});

test('resolveSettings: KV overrides env, env overrides defaults', () => {
  const d = resolveSettings({}, null);
  assert.deepEqual([d.landing, d.loginPath, d.hidden], [true, null, false]);
  const env = resolveSettings({ PUBLIC_LANDING: 'off', LOGIN_PATH: '/envpath-123' }, null);
  assert.deepEqual([env.landing, env.loginPath, env.hidden, env.source.landing, env.source.loginPath], [false, '/envpath-123', true, 'env', 'env']);
  const kv = resolveSettings({ PUBLIC_LANDING: 'off', LOGIN_PATH: '/envpath-123' }, { landing: true, loginPath: '/kvpath-1234' });
  assert.deepEqual([kv.landing, kv.loginPath, kv.hidden, kv.source.landing, kv.source.loginPath], [true, '/kvpath-1234', false, 'kv', 'kv']);
  for (const off of ['0', 'off', 'FALSE', 'no']) assert.equal(resolveSettings({ PUBLIC_LANDING: off, LOGIN_PATH: '/envpath-123' }, null).landing, false, off);
  assert.equal(resolveSettings({ PUBLIC_LANDING: 'on' }, null).landing, true);
});

test('resolveSettings: landing off without a usable login path stays visible (never a lockout)', () => {
  assert.equal(resolveSettings({ PUBLIC_LANDING: 'off' }, null).hidden, false);
  assert.equal(resolveSettings({ PUBLIC_LANDING: 'off', LOGIN_PATH: '/x' }, null).hidden, false); // invalid path ignored
  assert.equal(resolveSettings({}, { landing: false }).hidden, false);
});

test('validateChange', () => {
  assert.deepEqual(validateChange({ landing: true, loginPath: '' }), { ok: true, stored: { landing: true } });
  assert.deepEqual(validateChange({ landing: false, loginPath: 'my-secret-1' }), { ok: true, stored: { landing: false, loginPath: '/my-secret-1' } });
  assert.equal(validateChange({ landing: false, loginPath: '' }).ok, false);
  assert.equal(validateChange({ landing: true, loginPath: '/dashboard' }).ok, false);
  assert.equal(validateChange({ landing: true, loginPath: '/x' }).ok, false);
});

const shown = resolveSettings({}, null);
const hidden = resolveSettings({ PUBLIC_LANDING: 'off', LOGIN_PATH: '/secret-path-1' }, null);

test('publicRoute: landing shown (today\'s behaviour)', () => {
  assert.deepEqual(publicRoute('/', shown), { kind: 'home' });
  assert.deepEqual(publicRoute('/privacy', shown), { kind: 'privacy' });
  assert.deepEqual(publicRoute('/login', shown), { kind: 'legacy-login' });
  assert.equal(publicRoute('/anything', shown), null);
});

test('publicRoute: landing hidden: 404 for root and /login, sign-in only at the secret path', () => {
  assert.deepEqual(publicRoute('/', hidden), { kind: 'not-found' });
  assert.deepEqual(publicRoute('/login', hidden), { kind: 'not-found' });
  assert.deepEqual(publicRoute('/secret-path-1', hidden), { kind: 'login-page' });
  assert.deepEqual(publicRoute('/secret-path-1/github', hidden), { kind: 'login-start', provider: 'github' });
  assert.deepEqual(publicRoute('/privacy', hidden), { kind: 'privacy' });
  assert.equal(publicRoute('/other', hidden), null); // falls through to the plain 404
});

test('publicRoute: /mcp, OAuth, callback and agent are never decided here, in any mode', () => {
  for (const p of ['/mcp', '/token', '/register', '/authorize', '/callback', '/agent', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/dashboard', '/dashboard/files', '/f/abcdefghijklmnopqrstuv/x']) {
    assert.equal(publicRoute(p, shown), null, p);
    assert.equal(publicRoute(p, hidden), null, p);
  }
});
