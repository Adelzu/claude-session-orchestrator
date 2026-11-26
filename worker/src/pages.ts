import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Provider } from './identity.ts';
import { expiresIn, groupFiles, humanSize, sharedBy, sinceText, viewKind, type FileRow, type ViewItem } from './files.ts';
import type { Resolved } from './settings.ts';

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NAMES: Record<Provider, string> = { github: 'GitHub', google: 'Google', dev: 'Local dev login' };

const layout = (title: string, body: string, footer = true) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--accent:#c96442;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1a;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#e08a6a;--card:#252522}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px}h1{font-size:1.5rem;margin:0 0 12px}h2{font-size:1.1rem;margin:28px 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
code,pre{font:13px/1.5 ui-monospace,monospace}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
button,.btn{display:inline-block;font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;margin:4px 8px 4px 0}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}input[type=text]{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:100%;max-width:280px}
table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-top:1px solid var(--line);vertical-align:middle}.warn{border-color:var(--accent)}
a{color:var(--accent)}footer{margin-top:40px;font-size:14px}
</style></head><body><main>${body}${footer ? '<footer class="muted"><a href="/">Home</a> · <a href="/dashboard">Dashboard</a> · <a href="/privacy">Privacy</a> · <a href="https://github.com/Nurhak/claude-session-orchestrator">Source</a></footer>' : ''}</main></body></html>`;

export const messagePage = (msg: string, footer = true) => layout('Session Orchestrator', `<h1>Session Orchestrator</h1><p>${esc(msg)}</p>`, footer);

export const homePage = (origin: string) => layout('Session Orchestrator', `
<h1>Session Orchestrator</h1>
<p>Manage all your Claude Code sessions, on all your machines, from Claude: the app, voice mode, or another session.</p>
<div class="card"><strong>1.</strong> In Claude, add a custom connector with this URL and sign in with GitHub or Google:<pre>${esc(origin)}/mcp</pre>
<strong>2.</strong> Open the <a href="/dashboard">dashboard</a>, create an agent token, and start the agent on your always-on machine.</div>
<p class="muted">Your sessions, SSH keys and notes stay on your own machine. This service signs you in and relays tool calls to your own agent, nothing else.</p>`);

export const privacyPage = (origin: string, footer = true) => layout('Privacy · Session Orchestrator', `
<h1>Privacy policy</h1>
<p class="muted">Applies to ${esc(origin)}.</p>
<h2>What this service stores</h2>
<ul>
<li>Your account identifier from GitHub or Google (a numeric id or subject) and your username or email, to know which agent is yours.</li>
<li>OAuth grants and tokens for the Claude connector, stored as hashes by the OAuth library; profile details are encrypted.</li>
<li>Agent tokens you create, stored only as SHA-256 hashes, with the label and creation time you see in the dashboard.</li>
<li>The list of tools your agent advertises, so Claude can show them while your agent is offline.</li>
</ul>
<h2>What it does not store</h2>
<p>Tool arguments and results pass through to your own agent and back without being stored or logged by this service. Your sessions, code, notes, SSH keys and configuration stay on your machine.</p>
<h2>Third parties</h2>
<p>Sign-in uses GitHub or Google under their own privacy policies. The service runs on Cloudflare Workers.</p>
<h2>Deleting your data</h2>
<p>Revoke your agent tokens in the dashboard and disconnect the connector in Claude. For full deletion of your account record, open an issue at <a href="https://github.com/Nurhak/claude-session-orchestrator/issues">the project's GitHub</a>.</p>
<h2>Shared files</h2>
<p>Files you share from your own machine are streamed from your agent to you while you download them, only to your signed-in browser. This service does not store them.</p>`, footer);

export function consentPage(d: ConsentDescription, handle: string, providers: Provider[], footer = true) {
  const origin = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : 'This app registered itself; its name is not verified.';
  const buttons = providers.map((p, i) =>
    `<button name="provider" value="${p}"${i === 0 ? ' class="primary"' : ''}>Allow and sign in with ${NAMES[p]}</button>`).join('');
  return layout(`Authorize ${d.clientName}`, `
<h1>Allow ${esc(d.clientName)} to manage your sessions?</h1>
<div class="card">
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="card warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p>It will be able to start, read, message, approve and stop Claude Code sessions through <strong>your own agent</strong>, and use its notes and local models.</p>
</div>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
${buttons || '<p>Sign-in is not configured.</p>'}
<button name="provider" value="deny">Deny</button></form>`, footer);
}

/** Sign-in buttons. `href` builds each link, so hidden mode can point at the secret path. */
export const signInPage = (providers: Provider[], href: (p: Provider) => string, footer = true) =>
  layout('Sign in · Session Orchestrator', `<h1>Sign in</h1><p class="muted">Use the account that is allowed on this service.</p>
${providers.map((p) => `<a class="btn primary" href="${esc(href(p))}">Sign in with ${NAMES[p]}</a>`).join('') || '<p>Sign-in is not configured.</p>'}`, footer);

// ---------- dashboard: sidebar (tabs on phones) + one module per section ----------

interface Session { userId: string; name: string }
interface TokenRow { id: string; label: string; created: number }
interface Status { online: boolean; since: number | null; tools: number }
export type { FileRow, ViewItem };

export interface DashData {
  origin: string; user: Session; owner: boolean; active: string; status: Status | null;
  tokens: TokenRow[]; newToken: string | null;
  files: { ok: boolean; items: FileRow[]; error?: string } | null;
  settings: { resolved: Resolved; error?: string } | null;
  flash: string | null;
  confirm?: { id?: string; group?: string; name: string; count: number } | null;
}

const when = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * A section is a small module: add an entry to SECTIONS (and a route in index.ts) to add Users or Approvals later.
 * `ownerOnly` sections are hidden from, and refused to, everyone but the configured owners.
 */
interface Section { id: string; title: string; path: string; ownerOnly?: boolean; render: (d: DashData) => string }

const setup: Section = {
  id: 'setup', title: 'Setup', path: '/dashboard/setup',
  render: (d) => `<h1>Setup</h1>
<div class="card"><h2>Connector URL</h2><p class="muted">In Claude, add a custom connector with this address, then sign in.</p>
<pre class="copy">${esc(d.origin)}/mcp</pre></div>
<div class="card"><h2>Getting started</h2><ol class="steps">
<li><strong>Add the connector</strong> in Claude with the URL above.</li>
<li><strong>Create a token</strong> under <a href="/dashboard/machines">Machines</a>.</li>
<li><strong>Start the agent</strong> on your always-on machine; the command is shown with the new token.</li></ol>
<p>${d.status?.online ? '<span class="pill on">Agent online</span>' : '<span class="pill">Agent offline</span>'}</p></div>
<p class="muted">If you ever move this service to another address, update the connector URL in the Claude app too.</p>`,
};

const machines: Section = {
  id: 'machines', title: 'Machines', path: '/dashboard/machines',
  render: (d) => {
    const ws = d.origin.replace(/^http/, 'ws');
    const rows = d.tokens.map((t) => `<li class="row"><span class="grow"><strong>${esc(t.label)}</strong><br><span class="muted">created ${new Date(t.created).toISOString().slice(0, 10)}</span></span>
<form method="post" action="/dashboard/revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button>Revoke</button></form></li>`).join('');
    return `<h1>Machines</h1>
<div class="card"><span class="pill ${d.status?.online ? 'on' : ''}">${d.status?.online ? `Online since ${esc(when(d.status.since!))}` : 'Offline'}</span>
<span class="muted"> · ${d.status?.tools ?? 0} tools advertised</span></div>
${d.newToken ? `<div class="card warn"><strong>Your new agent token.</strong> Copy it now; it will not be shown again.<pre class="copy">${esc(d.newToken)}</pre>
On your always-on machine:<pre>git clone https://github.com/Nurhak/claude-session-orchestrator
cd claude-session-orchestrator &amp;&amp; npm ci
cp config/machines.example.yaml config/machines.yaml   # describe your machines
cp config/projects.example.yaml config/projects.yaml   # and your projects
printf 'ORCH_CLOUD_URL=${esc(ws)}/agent\\nORCH_AGENT_TOKEN=%s\\n' '${esc(d.newToken)}' &gt;&gt; .env
chmod 600 .env &amp;&amp; npm start</pre></div>` : ''}
<h2>Agent tokens</h2>
${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">No tokens yet.</p>'}
<form method="post" action="/dashboard/tokens" class="inline"><input type="text" name="label" placeholder="Label, e.g. home server" maxlength="60" aria-label="Token label"><button class="primary">Create token</button></form>`;
  },
};

const enc = encodeURIComponent;
const sharedText = (created: number, by: string) => `shared by ${esc(by)} · ${esc(when(created))} (${sinceText(created)})`;
const fileRow = (x: FileRow, showBy: boolean) => {
  const kind = viewKind(x.name);
  const open = kind === 'image' ? `<a class="btn" href="/view/${enc(x.id)}/${enc(x.name)}">View</a>`
    : kind ? `<a class="btn" href="/f/${enc(x.id)}/${enc(x.name)}?inline=1" target="_blank" rel="noopener">Open</a>` : '';
  return `<li class="row"><span class="grow"><strong>${esc(x.name)}</strong><br><span class="muted">${humanSize(x.size)} · expires in ${esc(expiresIn(x.expires))}</span>${showBy ? `<br><span class="muted">${sharedText(x.created, sharedBy(x))}</span>` : ''}</span>
${open}<a class="btn" href="/f/${enc(x.id)}/${enc(x.name)}">Download</a>
<a class="btn" href="/dashboard/files?revoke=${enc(x.id)}">Revoke</a></li>`;
};

const files: Section = {
  id: 'files', title: 'Files', path: '/dashboard/files',
  render: (d) => {
    const f = d.files;
    const c = d.confirm;
    const confirm = c ? `<div class="modal"><div class="card warn" role="alertdialog" aria-modal="true"><strong>${c.group ? `Delete the group "${esc(c.group)}"?` : `Revoke ${esc(c.name)}?`}</strong>
<p>${c.group ? `This stops sharing all ${c.count} file${c.count === 1 ? '' : 's'} in it now` : 'This stops sharing it now'} and cuts running downloads. The files on your machine are kept.</p>
<form method="post" action="/dashboard/files/revoke" class="inline"><input type="hidden" name="${c.group ? 'group' : 'id'}" value="${esc(c.group ?? c.id ?? '')}">
<button class="primary">${c.group ? 'Yes, delete group' : 'Yes, revoke'}</button><a class="btn" href="/dashboard/files">Cancel</a></form></div></div>` : '';
    const all = groupFiles(f?.items ?? []);
    const groups = all.map((g) => {
      const rows = (showBy: boolean) => g.labels.map((l) => `${l.label ? `<h3>${esc(l.label)}</h3>` : ''}<ul class="list">${l.items.map((x) => fileRow(x, showBy)).join('')}</ul>`).join('');
      if (g.name === null) return `${all.length > 1 ? '<h2 class="other">Other files</h2>' : ''}${rows(true)}`;
      const items = g.labels.flatMap((l) => l.items);
      const first = items.find((x) => viewKind(x.name) === 'image');
      const by = [...new Set(items.map(sharedBy))].join(', ');
      const at = Math.min(...items.map((x) => x.created));
      return `<details class="card group" data-g="${esc(g.name)}" open><summary class="grouphead"><span class="grow"><h2>${esc(g.name)} <span class="muted">· ${items.length} file${items.length === 1 ? '' : 's'}</span></h2>
<span class="muted">${sharedText(at, by)}</span></span>${first ? `<a class="btn" href="/view/${enc(first.id)}/${enc(first.name)}">View all</a>` : ''}<a class="btn" href="/dashboard/files?revoke_group=${enc(g.name)}">Delete group</a></summary>${rows(false)}</details>`;
    }).join('');
    return `<h1>Files</h1>
<p class="muted">Files your agent shares. They stream from your machine to this browser and are never stored here. Ask Claude to share one (file_share, optionally with a group).</p>
${d.flash ? `<div class="card warn">${esc(d.flash)}</div>` : ''}${confirm}
${!f || !f.ok ? `<div class="card warn">${esc(f?.error ?? 'Files are unavailable.')}</div>` : groups || '<p class="muted">Nothing is shared right now.</p>'}`;
  },
};

const settings: Section = {
  id: 'settings', title: 'Settings', path: '/dashboard/settings', ownerOnly: true,
  render: (d) => {
    const r = d.settings!.resolved;
    const url = r.loginPath ? `${d.origin}${r.loginPath}` : null;
    return `<h1>Settings</h1>
${d.flash ? `<div class="card warn">${esc(d.flash)}</div>` : ''}${d.settings!.error ? `<div class="card warn">${esc(d.settings!.error)}</div>` : ''}
<form method="post" action="/dashboard/settings" class="card">
<h2>Sign-in page</h2>
<p><label><input type="checkbox" name="landing" value="1"${r.landing ? ' checked' : ''}> Show the public landing page</label><br>
<span class="muted">Off: the home page and every unknown path return a plain 404, with no sign-in button. Sign-in is only at your secret path.</span></p>
<p><label for="lp"><strong>Secret login path</strong></label><br>
<input id="lp" type="text" name="login_path" value="${esc(r.loginPath ?? '')}" placeholder="/some-long-random-text" maxlength="65" autocomplete="off" spellcheck="false"></p>
<p><button class="primary" name="action" value="save">Save</button> <button name="action" value="generate">Generate random path</button></p>
<p class="muted">Applies within about a minute, no redeploy. The address stays ${esc(new URL(d.origin).host)}; only the path changes.</p></form>
<div class="card"><strong>Now:</strong> landing page ${r.hidden ? 'hidden' : r.landing ? 'shown' : 'shown (hiding needs a login path)'}.
${url ? `<br>Sign-in link (bookmark it):<pre class="copy">${esc(url)}</pre>` : '<br>No login path set.'}
<p class="muted">Not affected: the connector (/mcp), the OAuth routes and your agent. The connector URL in the Claude app does not change.</p>
<p class="muted">If you lose the path while the landing page is hidden, remove the cso:settings key in KV (wrangler kv key delete) and set LOGIN_PATH.</p></div>`;
  },
};

export const SECTIONS: Section[] = [files, setup, machines, settings];
export const sectionFor = (path: string) => SECTIONS.find((s) => s.path === path);

/**
 * Where /dashboard opens: Setup until a token exists; Machines while no machine is connected and nothing is shared;
 * otherwise Files. (Offline means the files cannot be listed, so `files` is 0 then.)
 */
export const defaultSection = (s: { tokens: number; online: boolean; files: number }): 'setup' | 'machines' | 'files' =>
  s.tokens === 0 ? 'setup' : !s.online && s.files === 0 ? 'machines' : 'files';

const DASH_CSS = `
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--accent:#c96442;--card:#fff;--ok:#2f8f5b}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1a;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#e08a6a;--card:#252522;--ok:#5cc58d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,sans-serif}
.shell{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:100vh}
.side{background:var(--card);border-right:1px solid var(--line);padding:20px 12px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
.brand{font-weight:650;padding:0 12px 16px}.side nav{display:flex;flex-direction:column;gap:2px}
.side nav a{display:flex;align-items:center;min-height:44px;padding:0 12px;border-radius:8px;color:var(--fg);text-decoration:none}
.side nav a:hover{background:var(--bg)}.side nav a[aria-current=page]{background:var(--bg);font-weight:600;box-shadow:inset 3px 0 0 var(--accent)}
.who{margin-top:auto;padding:12px;font-size:14px}.who form{margin-top:8px}
.content{padding:32px 28px;max-width:780px;width:100%}
h1{font-size:1.5rem;margin:0 0 16px}h2{font-size:1.05rem;margin:0 0 8px}.content>h2{margin-top:24px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}.warn{border-color:var(--accent)}
code,pre{font:13px/1.5 ui-monospace,monospace}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:8px 0}
pre.copy{user-select:all;cursor:copy}
button,.btn{display:inline-flex;align-items:center;min-height:44px;font:inherit;padding:0 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}
input[type=text]{font:inherit;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:100%;max-width:360px}
input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:8px}
.list{list-style:none;padding:0;margin:8px 0}.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:8px 0}
.row .grow{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}.row form{margin:0}
form.inline{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.pill{display:inline-block;padding:2px 12px;border-radius:99px;border:1px solid var(--line);font-size:14px}.pill.on{color:var(--ok);border-color:var(--ok)}
.steps{padding-left:20px}a{color:var(--accent)}
h3{font-size:.95rem;margin:12px 0 0;color:var(--muted);font-weight:600}.grouphead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;cursor:pointer;list-style:none}.grouphead::-webkit-details-marker{display:none}.grouphead::before{content:'\\25B8';color:var(--muted);width:1em}details[open]>.grouphead::before{content:'\\25BE'}.grouphead .grow{flex:1 1 200px;min-width:0}.grouphead h2{margin:0;display:block}.group .list{margin:4px 0 8px}.other{margin:24px 0 0}.modal{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5)}.modal .card{margin:0;max-width:420px;width:100%}
@media (max-width:720px){
.shell{grid-template-columns:minmax(0,1fr)}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px 0;flex-direction:row;flex-wrap:wrap;align-items:center}
.brand{padding:0 0 8px;flex:1}.who{margin:0 0 8px;padding:0}.who .name{display:none}.who form{margin:0}
.side nav{flex:0 0 100%;flex-direction:row;overflow-x:auto;order:3;gap:4px}.side nav a{white-space:nowrap;border-radius:8px 8px 0 0}
.side nav a[aria-current=page]{box-shadow:inset 0 -3px 0 var(--accent)}.content{padding:20px 16px}}
`;

/** Files page only: reload the list when the hub reports a change (Server-Sent Events); EventSource reconnects by itself. */
const LIVE_SCRIPT = `<script>
(function(){
if(!window.EventSource)return;
var timer=null,seen=false,es=new EventSource('/dashboard/events');
function refresh(){
  clearTimeout(timer);
  timer=setTimeout(function(){
    var open={};document.querySelectorAll('details[data-g]').forEach(function(x){open[x.dataset.g]=x.open});
    fetch(location.href,{credentials:'same-origin'}).then(function(r){return r.ok?r.text():null}).then(function(h){
      if(!h)return;
      var d=new DOMParser().parseFromString(h,'text/html'),n=d.querySelector('main.content'),c=document.querySelector('main.content');
      if(n&&c){c.innerHTML=n.innerHTML;document.querySelectorAll('details[data-g]').forEach(function(x){if(x.dataset.g in open)x.open=open[x.dataset.g]})}
    }).catch(function(){});
  },250);
}
es.addEventListener('files',refresh);
es.onopen=function(){if(seen)refresh();seen=true};
})();
</script>`;

export function dashboardPage(d: DashData) {
  const sections = SECTIONS.filter((s) => !s.ownerOnly || d.owner);
  const cur = sections.find((s) => s.id === d.active) ?? sections[0]!;
  const nav = sections.map((s) => `<a href="${s.path}"${s.id === cur.id ? ' aria-current="page"' : ''}>${s.title}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${cur.title} · Session Orchestrator</title><style>${DASH_CSS}</style></head><body><div class="shell">
<aside class="side"><div class="brand">Session Orchestrator</div><nav aria-label="Dashboard sections">${nav}</nav>
<div class="who"><span class="name muted">${esc(d.user.name)}</span><form method="post" action="/dashboard/logout"><button>Sign out</button></form></div></aside>
<main class="content">${cur.render(d)}</main></div>${cur.id === 'files' ? LIVE_SCRIPT : ''}</body></html>`;
}

// ---------- full-screen image viewer: actual size, carousel (arrows, keys, swipe) ----------

export function viewerPage(items: ViewItem[], index: number): string {
  const n = items.length;
  const at = (k: number) => items[((k % n) + n) % n]!;
  const src = (it: ViewItem) => `/f/${enc(it.id)}/${enc(it.name)}?inline=1`;
  const href = (it: ViewItem) => `/view/${enc(it.id)}/${enc(it.name)}`;
  const cur = at(index);
  const json = JSON.stringify(items.map((i) => ({ id: i.id, name: i.name, label: i.label }))).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cur.name)}</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#000;color:#eee;font:14px/1.4 system-ui,-apple-system,sans-serif}
body{display:flex;flex-direction:column;overflow:hidden}
.vis{position:absolute;opacity:0;pointer-events:none}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;padding:4px 12px;background:#111;border-bottom:1px solid #333;z-index:3}
.bar a,.bar label{color:#fff;text-decoration:none;display:inline-flex;align-items:center;min-height:44px;padding:0 4px;cursor:pointer}
.grow{flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dim{color:#9a9a9a}
.stage{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch}
.stage img{display:block;width:var(--w,auto);height:auto;max-width:none}
#fit:checked ~ .stage{display:flex;align-items:center;justify-content:center;overflow:hidden}
#fit:checked ~ .stage img{width:auto;max-width:100%;max-height:100%;object-fit:contain}
.nav{position:fixed;top:50%;transform:translateY(-50%);z-index:3;width:48px;height:72px;display:flex;align-items:center;justify-content:center;font-size:36px;color:#fff;background:rgba(0,0,0,.5);text-decoration:none;border-radius:8px}
.prev{left:8px}.next{right:8px}
</style></head><body data-i="${index}">
<input type="checkbox" id="fit" class="vis" aria-label="Fit to screen">
<div class="bar"><a href="/dashboard/files" id="back">← Files</a><span id="count">${index + 1}/${n}</span>
<span class="grow" id="cap">${cur.label ? `${esc(cur.label)} · ` : ''}${esc(cur.name)}</span><span class="dim" id="dim"></span>
<label for="fit">Fit to screen</label><a id="dl" href="/f/${enc(cur.id)}/${enc(cur.name)}">Download</a></div>
<div class="stage" id="stage"><img id="img" alt="${esc(cur.name)}" src="${src(cur)}"></div>
${n > 1 ? `<a class="nav prev" id="prev" href="${href(at(index - 1))}" aria-label="Previous">‹</a><a class="nav next" id="next" href="${href(at(index + 1))}" aria-label="Next">›</a>` : ''}
<script type="application/json" id="items">${json}</script>
<script>
(function(){
var items=JSON.parse(document.getElementById('items').textContent),n=items.length,i=Number(document.body.dataset.i);
var $=function(x){return document.getElementById(x)},img=$('img'),stage=$('stage');
var src=function(it){return '/f/'+it.id+'/'+encodeURIComponent(it.name)+'?inline=1'};
var href=function(it){return '/view/'+it.id+'/'+encodeURIComponent(it.name)};
var at=function(k){return items[((k%n)+n)%n]};
// 100% = one image pixel per device pixel: CSS size is the natural size divided by the device pixel ratio.
function size(){if(img.naturalWidth){img.style.setProperty('--w',(img.naturalWidth/window.devicePixelRatio)+'px');$('dim').textContent=img.naturalWidth+'×'+img.naturalHeight+' px'}}
img.addEventListener('load',function(){size();stage.scrollTo(0,0)});window.addEventListener('resize',size);if(img.complete)size();
function show(k){
  i=((k%n)+n)%n;var it=items[i];img.src=src(it);img.alt=it.name;document.title=it.name;
  $('count').textContent=(i+1)+'/'+n;$('cap').textContent=(it.label?it.label+' · ':'')+it.name;
  $('dl').href='/f/'+it.id+'/'+encodeURIComponent(it.name);
  if($('prev')){$('prev').href=href(at(i-1));$('next').href=href(at(i+1))}
  history.replaceState(null,'',href(it));var pre=new Image();pre.src=src(at(i+1));
}
if(n>1){
  $('prev').addEventListener('click',function(e){e.preventDefault();show(i-1)});
  $('next').addEventListener('click',function(e){e.preventDefault();show(i+1)});
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowLeft'){e.preventDefault();show(i-1)}else if(e.key==='ArrowRight'){e.preventDefault();show(i+1)}
    else if(e.key==='Escape'){location.href='/dashboard/files'}else if(e.key==='f'||e.key==='F'){$('fit').checked=!$('fit').checked}
  });
  // Swipe: at actual size the image pans first; a swipe only changes image once the edge of the image was already reached.
  var t=null;
  stage.addEventListener('touchstart',function(e){var p=e.changedTouches[0];
    t={x:p.clientX,y:p.clientY,l:stage.scrollLeft<=1,r:stage.scrollLeft+stage.clientWidth>=stage.scrollWidth-1}},{passive:true});
  stage.addEventListener('touchend',function(e){if(!t)return;var p=e.changedTouches[0],dx=p.clientX-t.x,dy=p.clientY-t.y,s=t;t=null;
    if(Math.abs(dx)<50||Math.abs(dx)<Math.abs(dy)*1.5)return;
    if(dx<0&&s.r)show(i+1);else if(dx>0&&s.l)show(i-1)},{passive:true});
}
})();
</script></body></html>`;
}
