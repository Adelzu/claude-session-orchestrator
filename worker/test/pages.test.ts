import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, dashboardPage, defaultSection, messagePage, privacyPage, sectionFor, signInPage, viewerPage, type DashData } from '../src/pages.ts';
import { resolveSettings } from '../src/settings.ts';

const base = (over: Partial<DashData> = {}): DashData => ({
  origin: 'https://orch.example', user: { userId: 'github-1', name: 'Adel' }, owner: false, active: 'files',
  status: { online: true, since: 1_700_000_000_000, tools: 28 }, tokens: [], newToken: null, files: null, settings: null, flash: null, ...over,
});
const navOf = (html: string) => [...html.matchAll(/<nav[^>]*>(.*?)<\/nav>/gs)][0]![1]!;

test('dashboard: Files first, then Setup, Machines; Settings last and only for owners', () => {
  const user = navOf(dashboardPage(base()));
  assert.deepEqual([...navOf(dashboardPage(base({ owner: true }))).matchAll(/>([A-Za-z]+)<\/a>/g)].map((m) => m[1]), ['Files', 'Setup', 'Machines', 'Settings']);
  assert.match(user, /Setup/); assert.match(user, /Machines/); assert.match(user, /Files/);
  assert.doesNotMatch(user, /Settings/);
  const owner = navOf(dashboardPage(base({ owner: true })));
  assert.match(owner, /Settings/);
  assert.equal(SECTIONS.find((s) => s.id === 'settings')?.ownerOnly, true);
  assert.equal(sectionFor('/dashboard/files')?.id, 'files');
  assert.equal(sectionFor('/dashboard/setup')?.id, 'setup');
  assert.equal(sectionFor('/dashboard'), undefined); // the bare path only redirects
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
  const h = dashboardPage(base({ active: 'setup' }));
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
  const items = [{ id: 'abcdefghijklmnopqrstuv', name: '<img src=x>.pdf', size: 4 * 1024 * 1024, expires: Date.now() + 28 * 60_000, group: null, label: null }];
  const h = dashboardPage(base({ active: 'files', files: { ok: true, items } }));
  assert.match(h, /href="\/f\/abcdefghijklmnopqrstuv\/%3Cimg%20src%3Dx%3E\.pdf"/);
  assert.match(h, /href="\/dashboard\/files\?revoke=abcdefghijklmnopqrstuv"/); // revoke goes through a confirm step
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
  assert.match(dashboardPage(base({ active: 'settings' })), /<h1>Files<\/h1>/);
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

const F = (id: string, name: string, group: string | null, label: string | null) => ({ id: id.padEnd(22, 'x'), name, size: 1000, expires: Date.now() + 3_600_000, group, label });

test('files: groups with sub-labels, View all, Delete group (confirm link), single files with View/Open/Download', () => {
  const items = [
    F('a1', 'S00.png', 'watermark-samples-1', '1920x1080'), F('a2', 'S02.png', 'watermark-samples-1', '1920x1080'),
    F('b1', 'S00.png', 'watermark-samples-1', '2560x1440'), F('p1', 'doc.pdf', null, null), F('t1', 'notes.txt', null, null), F('z1', 'a.bin', null, null),
  ];
  const h = dashboardPage(base({ active: 'files', files: { ok: true, items } }));
  assert.match(h, /watermark-samples-1 <span class="muted">· 3 files/);
  assert.match(h, /<h3>1920x1080<\/h3>/); assert.match(h, /<h3>2560x1440<\/h3>/);
  assert.ok(h.indexOf('1920x1080') < h.indexOf('2560x1440'));
  assert.match(h, />View all<\/a>/);
  assert.match(h, /href="\/dashboard\/files\?revoke_group=watermark-samples-1">Delete group/);
  assert.match(h, /Other files/);
  assert.match(h, /href="\/f\/p1x+\/doc\.pdf\?inline=1" target="_blank"[^>]*>Open/);
  assert.match(h, /href="\/view\/a1x+\/S00\.png">View</);
  assert.doesNotMatch(h, /a\.bin<\/strong>[^]*?>View</); // the .bin file offers only Download
  assert.match(h, /href="\/f\/z1x+\/a\.bin">Download/);
});

test('files: confirm step for one file and for a group; flash', () => {
  const one = dashboardPage(base({ active: 'files', files: { ok: true, items: [F('a1', 'S00.png', null, null)] }, confirm: { id: 'a1xxxxxxxxxxxxxxxxxxxx', name: 'S00.png', count: 1 } }));
  assert.match(one, /Revoke S00\.png\?/);
  assert.match(one, /method="post" action="\/dashboard\/files\/revoke"[^]*name="id" value="a1x+"/);
  assert.match(one, /Cancel/);
  const grp = dashboardPage(base({ active: 'files', files: { ok: true, items: [] }, confirm: { group: 'g <1>', name: 'g <1>', count: 4 } }));
  assert.match(grp, /Delete the group "g &#60;1&#62;"\?/);
  assert.match(grp, /all 4 files/);
  assert.match(grp, /name="group" value="g &#60;1&#62;"/);
  assert.match(dashboardPage(base({ active: 'files', files: { ok: true, items: [] }, flash: 'Share revoked.' })), /Share revoked\./);
});

test('defaultSection: Setup without tokens, Machines when offline with nothing shared, otherwise Files', () => {
  assert.equal(defaultSection({ tokens: 0, online: false, files: 0 }), 'setup');
  assert.equal(defaultSection({ tokens: 0, online: true, files: 5 }), 'setup');
  assert.equal(defaultSection({ tokens: 1, online: false, files: 0 }), 'machines');
  assert.equal(defaultSection({ tokens: 2, online: true, files: 0 }), 'files');
  assert.equal(defaultSection({ tokens: 1, online: false, files: 3 }), 'files');
  assert.equal(defaultSection({ tokens: 1, online: true, files: 3 }), 'files');
});

test('viewer: actual-size image, counter, name, fit toggle, arrows as real links, keys and swipe wired', () => {
  const items = [1, 2, 3].map((n) => ({ id: `id${n}`.padEnd(22, 'x'), name: `S0${n}.png`, label: n === 3 ? '2560x1440' : '1920x1080' }));
  const h = viewerPage(items, 1);
  assert.match(h, /<span id="count">2\/3<\/span>/);
  assert.match(h, /1920x1080 · S02\.png/);
  assert.match(h, /id="fit"/); assert.match(h, /Fit to screen/);
  assert.match(h, /src="\/f\/id2x+\/S02\.png\?inline=1"/);
  assert.match(h, /id="prev" href="\/view\/id1x+\/S01\.png"/);
  assert.match(h, /id="next" href="\/view\/id3x+\/S03\.png"/);
  assert.match(h, /devicePixelRatio/);                  // 1 image pixel = 1 device pixel
  assert.match(h, /max-width:none/);                    // never shrunk at actual size
  assert.match(h, /ArrowLeft/); assert.match(h, /ArrowRight/); assert.match(h, /touchend/);
  // wrap-around at the ends
  assert.match(viewerPage(items, 0), /id="prev" href="\/view\/id3x+\/S03\.png"/);
  assert.match(viewerPage(items, 2), /id="next" href="\/view\/id1x+\/S01\.png"/);
  // single image: no arrows
  assert.doesNotMatch(viewerPage(items.slice(0, 1), 0), /id="prev"/);
  // hostile names cannot break out of the page or the embedded JSON
  const evil = viewerPage([{ id: 'e'.repeat(22), name: '</script><img src=x onerror=alert(1)>.png', label: '"><b>' }], 0);
  assert.doesNotMatch(evil, /<\/script><img/);
  assert.doesNotMatch(evil, /<b>/);
});
