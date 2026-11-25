import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, dashboardPage, messagePage, privacyPage, sectionFor, signInPage, type DashData } from '../src/pages.ts';
import { resolveSettings } from '../src/settings.ts';

const base = (over: Partial<DashData> = {}): DashData => ({
  origin: 'https://orch.example', user: { userId: 'github-1', name: 'Adel' }, owner: false, active: 'setup',
  status: { online: true, since: 1_700_000_000_000, tools: 28 }, tokens: [], newToken: null, files: null, settings: null, flash: null, ...over,
});
const navOf = (html: string) => [...html.matchAll(/<nav[^>]*>(.*?)<\/nav>/gs)][0]![1]!;

test('dashboard: Setup, Machines, Files for everyone; Settings only for owners', () => {
  const user = navOf(dashboardPage(base()));
  assert.match(user, /Setup/); assert.match(user, /Machines/); assert.match(user, /Files/);
  assert.doesNotMatch(user, /Settings/);
  const owner = navOf(dashboardPage(base({ owner: true })));
  assert.match(owner, /Settings/);
  assert.equal(SECTIONS.find((s) => s.id === 'settings')?.ownerOnly, true);
  assert.equal(sectionFor('/dashboard/files')?.id, 'files');
  assert.equal(sectionFor('/dashboard/nope'), undefined);
});

test('dashboard: mobile and theme basics', () => {
  const h = dashboardPage(base());
  assert.match(h, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(h, /prefers-color-scheme:dark/);
  assert.match(h, /max-width:720px/);
  assert.match(h, /aria-current="page"/);
  assert.doesNotMatch(h, /<script/); // no client JS
});

test('setup: connector URL, steps and the warning about moving the address', () => {
  const h = dashboardPage(base());
  assert.match(h, /https:\/\/orch\.example\/mcp/);
  assert.match(h, /Getting started/);
  assert.match(h, /update the connector URL in the Claude app/);
});

test('machines: token create/revoke forms, new token shown once with the start command', () => {
  const h = dashboardPage(base({ active: 'machines', newToken: 'cso_secret', tokens: [{ id: 't1', label: 'home <b>', created: 1_700_000_000_000 }] }));
  assert.match(h, /action="\/dashboard\/tokens"/);
  assert.match(h, /action="\/dashboard\/revoke"/);
  assert.match(h, /cso_secret/);
  assert.match(h, /wss:\/\/orch\.example\/agent/);
  assert.doesNotMatch(h, /home <b>/); // escaped
});

test('files: rows with download and revoke, names escaped, errors shown', () => {
  const items = [{ id: 'abcdefghijklmnopqrstuv', name: '<img src=x>.pdf', size: 4 * 1024 * 1024, expires: Date.now() + 28 * 60_000 }];
  const h = dashboardPage(base({ active: 'files', files: { ok: true, items } }));
  assert.match(h, /href="\/f\/abcdefghijklmnopqrstuv\/%3Cimg%20src%3Dx%3E\.pdf"/);
  assert.match(h, /action="\/dashboard\/files\/revoke"/);
  assert.match(h, /4\.0 MB/);
  assert.doesNotMatch(h, /<img src=x>/);
  assert.match(dashboardPage(base({ active: 'files', files: { ok: true, items: [] } })), /Nothing is shared/);
  assert.match(dashboardPage(base({ active: 'files', files: { ok: false, items: [], error: 'Your agent is offline' } })), /Your agent is offline/);
});

test('settings: owner form with the current values, never the connector URL change', () => {
  const resolved = resolveSettings({ PUBLIC_LANDING: 'off', LOGIN_PATH: '/secret-path-1' }, null);
  const h = dashboardPage(base({ owner: true, active: 'settings', settings: { resolved }, flash: 'Saved.' }));
  assert.match(h, /action="\/dashboard\/settings"/);
  assert.match(h, /value="\/secret-path-1"/);
  assert.doesNotMatch(h, /name="landing" value="1" checked/);
  assert.match(h, /https:\/\/orch\.example\/secret-path-1/);
  assert.match(h, /Saved\./);
  assert.match(h, /name="action" value="generate"/);
  // A non-owner asking for the settings section gets the first visible section instead.
  assert.match(dashboardPage(base({ active: 'settings' })), /<h1>Setup<\/h1>/);
});

test('hidden mode: public pages carry no site links and no sign-in outside the secret page', () => {
  for (const html of [messagePage('x', false), privacyPage('https://o', false), signInPage([], () => '', false)]) {
    assert.doesNotMatch(html, /<footer/);
    assert.doesNotMatch(html, /href="\/dashboard"/);
  }
  const page = signInPage(['github'], (p) => `/secret-path-1/${p}`, false);
  assert.match(page, /href="\/secret-path-1\/github"/);
  assert.match(messagePage('x'), /<footer/);
});
