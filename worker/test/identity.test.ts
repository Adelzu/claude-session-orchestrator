// Sign-in allowlists: GitHub (ids) and Google (verified, exact emails). Provider endpoints are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUrl, exchange, providers } from '../src/identity.ts';

const req = new Request('https://orch.example/callback');
const realFetch = globalThis.fetch;
const json = (o: object) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

function fake(google: object | null, github: object | null = null) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token') || u.includes('github.com/login/oauth/access_token')) return json({ access_token: 't' });
    if (u.includes('openidconnect.googleapis.com')) return json(google ?? {});
    if (u.includes('api.github.com/user')) return json(github ?? {});
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const g = (env: object) => exchange('google', req, { GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', ...env } as never, 'code', 'ver');
const gh = (env: object) => exchange('github', req, { GITHUB_CLIENT_ID: 'i', GITHUB_CLIENT_SECRET: 's', ...env } as never, 'code', 'ver');

test('google: an allowed, verified email signs in (case and spaces in the list do not matter)', async () => {
  fake({ sub: '123', email: 'Adel@Example.com', email_verified: true });
  assert.deepEqual(await g({ ALLOWED_GOOGLE_EMAILS: ' other@x.com, adel@example.com ' }), { userId: 'google-123', name: 'adel@example.com' });
});

test('google: an email that is not on the list is denied', async () => {
  fake({ sub: '1', email: 'eve@example.com', email_verified: true });
  await assert.rejects(g({ ALLOWED_GOOGLE_EMAILS: 'adel@example.com' }), /not allowed/);
  fake({ sub: '1', email: 'xadel@example.com', email_verified: true }); // exact match only, no suffix or substring
  await assert.rejects(g({ ALLOWED_GOOGLE_EMAILS: 'adel@example.com' }), /not allowed/);
});

test('google: an unverified email is denied even when listed', async () => {
  for (const email_verified of [false, undefined, 'true' as unknown as boolean]) {
    fake({ sub: '1', email: 'adel@example.com', email_verified });
    await assert.rejects(g({ ALLOWED_GOOGLE_EMAILS: 'adel@example.com' }), /not allowed/);
  }
});

test('google: an empty or unset list denies everyone', async () => {
  fake({ sub: '1', email: 'adel@example.com', email_verified: true });
  for (const v of [undefined, '', ' , ,']) await assert.rejects(g({ ALLOWED_GOOGLE_EMAILS: v }), /not allowed/);
  fake({ sub: '1', email_verified: true }); // no email at all
  await assert.rejects(g({ ALLOWED_GOOGLE_EMAILS: 'adel@example.com' }), /not allowed/);
});

test('github: allowlist behaviour is unchanged', async () => {
  fake(null, { id: 42, login: 'adel' });
  assert.deepEqual(await gh({ ALLOWED_GITHUB_IDS: '7, 42' }), { userId: 'github-42', name: 'adel' });
  await assert.rejects(gh({ ALLOWED_GITHUB_IDS: '7' }), /not allowed/);
  for (const v of [undefined, '']) await assert.rejects(gh({ ALLOWED_GITHUB_IDS: v }), /not allowed/);
  // The Google list does not let a GitHub user in, and the GitHub list does not affect Google.
  await assert.rejects(gh({ ALLOWED_GOOGLE_EMAILS: 'adel@example.com' }), /not allowed/);
});

// Each provider exists only when BOTH its id and secret are set. Combinations: GitHub only, Google only, both, neither,
// and half-configured. A disabled provider: no button, no authorize URL, and never a call to the provider.
const GH = { GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'ghs' }, GO = { GOOGLE_CLIENT_ID: 'go', GOOGLE_CLIENT_SECRET: 'gos' };
const ALLOW = { ALLOWED_GITHUB_IDS: '42', ALLOWED_GOOGLE_EMAILS: 'adel@example.com' };
const combos: [string, object, string[]][] = [
  ['GitHub only', GH, ['github']],
  ['Google only', GO, ['google']],
  ['both', { ...GH, ...GO }, ['github', 'google']],
  ['neither', {}, []],
  ['GitHub id without secret', { GITHUB_CLIENT_ID: 'gh', ...GO }, ['google']],
  ['GitHub secret without id', { GITHUB_CLIENT_SECRET: 'ghs', ...GO }, ['google']],
  ['Google id without secret', { ...GH, GOOGLE_CLIENT_ID: 'go' }, ['github']],
  ['Google secret without id', { ...GH, GOOGLE_CLIENT_SECRET: 'gos' }, ['github']],
  ['empty strings', { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, []],
];
for (const [name, keys, on] of combos) {
  test(`providers (${name}): only ${on.join(' + ') || 'nothing'} is visible and usable`, async () => {
    const e = { ...keys, ...ALLOW } as never;
    assert.deepEqual(providers(req, e), on, 'buttons shown');
    let calls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls++;
      const u = String(url);
      if (u.includes('userinfo')) return json({ sub: '1', email: 'adel@example.com', email_verified: true });
      if (u.includes('api.github.com')) return json({ id: 42, login: 'adel' });
      return json({ access_token: 't' });
    }) as typeof fetch;
    for (const p of ['github', 'google'] as const) {
      if (on.includes(p)) {
        assert.match(await authorizeUrl(p, req, e, 'st', 'ver'), p === 'github' ? /^https:\/\/github\.com\// : /^https:\/\/accounts\.google\.com\//);
      } else {
        const before = calls;
        await assert.rejects(authorizeUrl(p, req, e, 'st', 'ver'), /not configured/);
        await assert.rejects(exchange(p, req, e, 'code', 'ver'), /not configured/);
        assert.equal(calls, before, `${p}: the token exchange is never reached`);
      }
    }
    // A configured provider still obeys its own allowlist.
    for (const p of on as ('github' | 'google')[]) assert.ok((await exchange(p, req, e, 'code', 'ver')).userId.startsWith(`${p}-`));
  });
}
