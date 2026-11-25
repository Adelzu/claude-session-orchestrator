import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Provider } from './identity.ts';
import { expiresIn, humanSize } from './files.ts';
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
export interface FileRow { id: string; name: string; size: number; expires: number }

export interface DashData {
  origin: string; user: Session; owner: boolean; active: string; status: Status | null;
  tokens: TokenRow[]; newToken: string | null;
  files: { ok: boolean; items: FileRow[]; error?: string } | null;
  settings: { resolved: Resolved; error?: string } | null;
  flash: string | null;
}

const when = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * A section is a small module: add an entry to SECTIONS (and a route in index.ts) to add Users or Approvals later.
 * `ownerOnly` sections are hidden from, and refused to, everyone but the configured owners.
 */
interface Section { id: string; title: string; path: string; ownerOnly?: boolean; render: (d: DashData) => string }

const setup: Section = {
  id: 'setup', title: 'Setup', path: '/dashboard',
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

const files: Section = {
  id: 'files', title: 'Files', path: '/dashboard/files',
  render: (d) => {
    const f = d.files;
    const rows = (f?.items ?? []).map((x) => `<li class="row"><span class="grow"><strong>${esc(x.name)}</strong><br><span class="muted">${humanSize(x.size)} · expires in ${esc(expiresIn(x.expires))}</span></span>
<a class="btn" href="/f/${encodeURIComponent(x.id)}/${encodeURIComponent(x.name)}">Download</a>
<form method="post" action="/dashboard/files/revoke"><input type="hidden" name="id" value="${esc(x.id)}"><button>Revoke</button></form></li>`).join('');
    return `<h1>Files</h1>
<p class="muted">Files your agent shares for download. They stream from your machine to this browser and are never stored here. Ask Claude to share one (file_share).</p>
${!f || !f.ok ? `<div class="card warn">${esc(f?.error ?? 'Files are unavailable.')}</div>` : rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">Nothing is shared right now.</p>'}`;
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

export const SECTIONS: Section[] = [setup, machines, files, settings];
export const sectionFor = (path: string) => SECTIONS.find((s) => s.path === path);

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
@media (max-width:720px){
.shell{grid-template-columns:minmax(0,1fr)}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px 0;flex-direction:row;flex-wrap:wrap;align-items:center}
.brand{padding:0 0 8px;flex:1}.who{margin:0 0 8px;padding:0}.who .name{display:none}.who form{margin:0}
.side nav{flex:0 0 100%;flex-direction:row;overflow-x:auto;order:3;gap:4px}.side nav a{white-space:nowrap;border-radius:8px 8px 0 0}
.side nav a[aria-current=page]{box-shadow:inset 0 -3px 0 var(--accent)}.content{padding:20px 16px}}
`;

export function dashboardPage(d: DashData) {
  const sections = SECTIONS.filter((s) => !s.ownerOnly || d.owner);
  const cur = sections.find((s) => s.id === d.active) ?? sections[0]!;
  const nav = sections.map((s) => `<a href="${s.path}"${s.id === cur.id ? ' aria-current="page"' : ''}>${s.title}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${cur.title} · Session Orchestrator</title><style>${DASH_CSS}</style></head><body><div class="shell">
<aside class="side"><div class="brand">Session Orchestrator</div><nav aria-label="Dashboard sections">${nav}</nav>
<div class="who"><span class="name muted">${esc(d.user.name)}</span><form method="post" action="/dashboard/logout"><button>Sign out</button></form></div></aside>
<main class="content">${cur.render(d)}</main></div></body></html>`;
}
