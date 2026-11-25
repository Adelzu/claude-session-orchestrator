// Hosted front door for claude-session-orchestrator.
//  /mcp        stateless MCP endpoint (OAuth 2.1 via @cloudflare/workers-oauth-provider); relays tool
//              calls to the signed-in user's own agent through their Durable Object.
//  /authorize  consent page + GitHub/Google sign-in for MCP clients (Claude).
//  /dashboard  web sign-in to create and revoke agent tokens.
//  /agent      WebSocket the user's agent dials out to (agent token).
import { AuthorizationError, CimdFetchError, OAuthProvider, authorizationErrorRedirect, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authorizeUrl, exchange, providers, type Provider } from './identity.ts';
import { SECTIONS, consentPage, dashboardPage, defaultSection, homePage, messagePage, privacyPage, sectionFor, signInPage, viewerPage, type DashData } from './pages.ts';
import { carouselOf, parseFilePath, parseViewPath, viewKind } from './files.ts';
import { SETTINGS_KEY, generateLoginPath, publicRoute, resolveSettings, validateChange, type Resolved, type Stored } from './settings.ts';
import { UserHub, type ToolInfo } from './hub.ts';

export { UserHub };

export interface Env {
  OAUTH_KV: KVNamespace;
  USER_HUB: DurableObjectNamespace<UserHub>;
  OAUTH_PROVIDER: OAuthHelpers;
  COOKIE_SECRET: string;
  GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; ALLOWED_GITHUB_IDS?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; ALLOWED_GOOGLE_EMAILS?: string;
  OWNER_IDS?: string; LOGIN_PATH?: string; PUBLIC_LANDING?: string;
  DEV_LOGIN?: string;
}
interface Props { userId: string; name: string }

const SCOPE = 'mcp';
const hub = (env: Env, userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));
const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-security-policy', "script-src 'self' 'unsafe-inline'; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://github.com https://accounts.google.com https://claude.ai; frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  return new Response(body, { status, headers });
};

// ---------- MCP: stateless, one Server per request ----------

const SETUP_TOOL: ToolInfo = {
  name: 'orchestrator_setup',
  title: 'Set up your orchestrator agent',
  description: 'Explains how to connect your own machine. Call this when no other orchestrator tools are listed or a tool says the agent is offline.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Set up your orchestrator agent', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const setupText = (origin: string) =>
  `Your orchestrator agent is not connected. Open ${origin}/dashboard, sign in with the same account, create an agent token, and start the agent on your always-on machine (see the dashboard for the exact command). Your sessions, SSH keys and notes stay on your machine; this service only relays tool calls to your own agent.`;

const mcpApi: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const { userId } = (ctx as unknown as { props: Props }).props;
    const origin = new URL(request.url).origin;
    const stub = hub(env, userId);
    const server = new Server(
      { name: 'claude-session-orchestrator', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: "Manages the user's Claude Code sessions on their own machines. In voice mode, call events_pending first. Every tool result starts with a one-sentence summary to read out. Long work: a client cannot run two calls to the same tool at once, so call session_send with wait=0, then wait with session_wait (a separate tool, which leaves session_send free for other sessions). Never rely on a single call longer than 180 s: some clients (such as the Claude app) drop calls at about 240 s. Instead poll in short steps (session_read mode=summary about every 30 s) or call session_wait in chunks of 180 s or less, and repeat until the turn is done." },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = (await stub.tools()) as ToolInfo[];
      return { tools: tools.length ? tools : [SETUP_TOOL] } as never;
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const text = (summary: string) => ({ content: [{ type: 'text', text: JSON.stringify({ summary }) }], isError: true });
      if (req.params.name === SETUP_TOOL.name) return { content: [{ type: 'text', text: JSON.stringify({ summary: setupText(origin) }) }] };
      const result = await stub.call(req.params.name, req.params.arguments ?? {});
      return (result ?? text(setupText(origin))) as never;
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ---------- signed cookies (dashboard session, dashboard login state) ----------

const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(env: Env, data: string) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) throw new Error('COOKIE_SECRET must be set (32+ chars)');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
async function seal(env: Env, value: object, maxAgeS: number) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ ...value, exp: Date.now() + maxAgeS * 1000 })));
  return `${body}.${await hmac(env, body)}`;
}
async function unseal<T>(env: Env, token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || (await hmac(env, body)) !== sig) return null;
  const v = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as T & { exp: number };
  return v.exp > Date.now() ? v : null;
}
const cookie = (req: Request, name: string) =>
  req.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const SESSION = '__Host-cso-session', LOGIN = '__Host-cso-login';

// ---------- agent tokens (KV; only SHA-256 hashes stored) ----------

interface TokenRecord { id: string; userId: string; label: string; created: number }
const sha256 = async (s: string) => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function listTokens(env: Env, userId: string): Promise<TokenRecord[]> {
  return (await env.OAUTH_KV.get<TokenRecord[]>(`cso:user-tokens:${userId}`, 'json')) ?? [];
}
async function createToken(env: Env, userId: string, label: string) {
  const token = `cso_${b64u(crypto.getRandomValues(new Uint8Array(32)))}`;
  const rec: TokenRecord = { id: crypto.randomUUID(), userId, label: label.slice(0, 60) || 'agent', created: Date.now() };
  await env.OAUTH_KV.put(`cso:agent:${await sha256(token)}`, JSON.stringify(rec));
  await env.OAUTH_KV.put(`cso:token-hash:${rec.id}`, await sha256(token));
  await env.OAUTH_KV.put(`cso:user-tokens:${userId}`, JSON.stringify([...(await listTokens(env, userId)), rec]));
  return token;
}
async function revokeToken(env: Env, userId: string, id: string) {
  const list = await listTokens(env, userId);
  if (!list.some((t) => t.id === id)) return; // only the owner can revoke
  const hash = await env.OAUTH_KV.get(`cso:token-hash:${id}`);
  if (hash) await env.OAUTH_KV.delete(`cso:agent:${hash}`);
  await env.OAUTH_KV.delete(`cso:token-hash:${id}`);
  await env.OAUTH_KV.put(`cso:user-tokens:${userId}`, JSON.stringify(list.filter((t) => t.id !== id)));
  await hub(env, userId).disconnect(id);
}

// ---------- settings, owners, dashboard helpers ----------

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
/** Settings (KV) over env defaults. A KV hiccup falls back to the env values. */
async function loadSettings(env: Env): Promise<Resolved> {
  let stored: Stored | null = null;
  try { stored = await env.OAUTH_KV.get<Stored>(SETTINGS_KEY, 'json'); } catch { /* env values apply */ }
  return resolveSettings(env, stored);
}
/** Owners (OWNER_IDS, comma-separated user ids such as github-123) may change Settings; none configured = nobody. */
const isOwner = (env: Env, userId: string) => (env.OWNER_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean).includes(userId);

async function fetchFiles(stub: ReturnType<typeof hub>, online: boolean): Promise<NonNullable<DashData['files']>> {
  if (!online) return { ok: false, items: [], error: 'Your agent is offline, so shared files cannot be listed.' };
  const r = (await stub.call('file_list', {}, 8000)) as unknown as { content?: { text?: string }[]; isError?: boolean } | null;
  try {
    const j = JSON.parse(r?.content?.[0]?.text ?? '') as { summary?: string; files?: { id: string; name: string; size: number; expires: string; group?: string | null; label?: string | null }[] };
    if (r?.isError || !Array.isArray(j.files)) return { ok: false, items: [], error: j.summary ?? 'Files are unavailable.' };
    return { ok: true, items: j.files.map((f) => ({ id: String(f.id), name: String(f.name), size: Number(f.size), expires: Date.parse(f.expires), group: f.group ?? null, label: f.label ?? null })) };
  } catch {
    return { ok: false, items: [], error: 'The agent did not return a file list. Is it up to date?' };
  }
}

const DONE: Record<string, string> = { revoked: 'Share revoked.', group: 'Group deleted.', failed: 'Could not revoke: it is already gone, or the agent is offline.' };
/** file_revoke on the agent; true when it revoked something. */
async function revokeFiles(stub: ReturnType<typeof hub>, args: { id: string } | { group: string }): Promise<boolean> {
  const r = (await stub.call('file_revoke', args, 8000)) as unknown as { isError?: boolean } | null;
  return !!r && !r.isError;
}

async function dashboardResponse(env: Env, origin: string, session: Props, active: string, s: Resolved, extra: { newToken?: string; flash?: string; settingsError?: string; status?: number; confirmId?: string; confirmGroup?: string } = {}) {
  const stub = hub(env, session.userId);
  const status = await stub.status();
  const data: DashData = { origin, user: session, owner: isOwner(env, session.userId), active, status, tokens: [], newToken: extra.newToken ?? null, files: null, settings: null, flash: extra.flash ?? null };
  if (active === 'machines') data.tokens = await listTokens(env, session.userId);
  if (active === 'files') {
    data.files = await fetchFiles(stub, status.online);
    const items = data.files.items;
    if (extra.confirmGroup) {
      const n = items.filter((f) => f.group === extra.confirmGroup).length;
      data.confirm = n ? { group: extra.confirmGroup, name: extra.confirmGroup, count: n } : null;
    } else if (extra.confirmId) {
      const f = items.find((x) => x.id === extra.confirmId);
      data.confirm = f ? { id: f.id, name: f.name, count: 1 } : null;
    }
    if (!data.confirm && (extra.confirmId || extra.confirmGroup)) data.flash = 'That share is already gone.';
  }
  if (active === 'settings' && data.owner) data.settings = { resolved: s, error: extra.settingsError };
  return html(dashboardPage(data), extra.status ?? 200);
}

// ---------- routes ----------

async function startLogin(request: Request, env: Env, provider: Provider, devUser: string) {
  const state = `dash.${b64u(crypto.getRandomValues(new Uint8Array(24)))}`;
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const headers = new Headers({ location: await authorizeUrl(provider, request, env, state, verifier, devUser) });
  headers.append('set-cookie', setCookie(LOGIN, await seal(env, { state, verifier, provider }, 600), 600));
  return new Response(null, { status: 302, headers });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;
  const set = await loadSettings(env);
  const footer = !set.hidden; // with the landing page hidden, no page links around the site
  const loginHref = (p: Provider) => (set.hidden ? `${set.loginPath}/${p}` : `/login?provider=${p}`);

  const pub = publicRoute(url.pathname, set);
  if (pub?.kind === 'not-found') return notFound();
  if (pub?.kind === 'home') return html(homePage(url.origin));
  if (pub?.kind === 'privacy') return html(privacyPage(url.origin, footer));
  if (pub?.kind === 'login-page') return html(signInPage(providers(request, env), loginHref, footer));
  if (pub?.kind === 'login-start' || pub?.kind === 'legacy-login') {
    const provider = (pub.kind === 'login-start' ? pub.provider : url.searchParams.get('provider')) as Provider;
    if (!providers(request, env).includes(provider)) return html(messagePage('Unknown sign-in provider.', footer), 400);
    return startLogin(request, env, provider, url.searchParams.get('as') ?? 'local');
  }

  // The user's agent dials in here with its token.
  if (url.pathname === '/agent') {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const rec = token.startsWith('cso_') ? await env.OAUTH_KV.get<TokenRecord>(`cso:agent:${await sha256(token)}`, 'json') : null;
    if (!rec) return new Response('invalid agent token', { status: 401 });
    const fwd = new Request(request, { headers: new Headers(request.headers) });
    fwd.headers.set('x-agent-token-id', rec.id);
    return hub(env, rec.userId).fetch(fwd);
  }

  // MCP client authorization: consent first, then sign-in with the chosen provider.
  if (url.pathname === '/authorize' && request.method === 'GET') {
    const authReq = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authReq);
    const consent = await oauth.beginConsent(authReq);
    return html(consentPage(details, consent.handle, providers(request, env), footer), 200, consent.headers);
  }
  if (url.pathname === '/authorize' && request.method === 'POST') {
    const form = await request.formData();
    const handleId = String(form.get('handle'));
    const provider = String(form.get('provider')) as Provider;
    if (!providers(request, env).includes(provider)) {
      const denied = await oauth.denyConsent(request, handleId);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handleId, { scope: [SCOPE] });
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier, provider }, headers: approved.headers });
    headers.set('location', await authorizeUrl(provider, request, env, state, verifier, String(form.get('dev_user') ?? 'local')));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === '/callback') {
    const state = url.searchParams.get('state') ?? '';
    // Dashboard sign-in (our own state, bound to a signed cookie).
    if (state.startsWith('dash.')) {
      const login = await unseal<{ state: string; verifier: string; provider: Provider }>(env, cookie(request, LOGIN));
      if (!login || login.state !== state || url.searchParams.get('error')) return html(messagePage('Sign-in failed or expired. Please try again.', footer), 400);
      if (!providers(request, env).includes(login.provider)) return html(messagePage('Not found.', footer), 404);
      const who = await exchange(login.provider, request, env, url.searchParams.get('code') ?? '', login.verifier);
      const headers = new Headers({ location: '/dashboard' });
      headers.append('set-cookie', setCookie(SESSION, await seal(env, who, 7 * 86400), 7 * 86400));
      headers.append('set-cookie', setCookie(LOGIN, '', 0));
      return new Response(null, { status: 302, headers });
    }
    // MCP client authorization.
    const resumed = await oauth.finishUpstream<{ verifier: string; provider: Provider }>(request);
    if (!providers(request, env).includes(resumed.data.provider)) return html(messagePage('Not found.', footer), 404);
    if (url.searchParams.get('error')) {
      resumed.headers.set('location', authorizationErrorRedirect(resumed.request, 'access_denied'));
      return new Response(null, { status: 302, headers: resumed.headers });
    }
    const who = await exchange(resumed.data.provider, request, env, url.searchParams.get('code') ?? '', resumed.data.verifier);
    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request, userId: who.userId, metadata: { name: who.name }, scope: resumed.request.scope,
      props: { userId: who.userId, name: who.name } satisfies Props,
    });
    resumed.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: resumed.headers });
  }

  // Dashboard and file downloads: same signed session cookie. Without one, a hidden site answers 404.
  const session = await unseal<Props>(env, cookie(request, SESSION));
  const signedOut = () => (set.hidden ? notFound() : html(signInPage(providers(request, env), loginHref, footer)));

  const fileId = parseFilePath(url.pathname);
  if (fileId && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!session) return set.hidden ? notFound() : html(messagePage('Sign in at the dashboard first, then open this link again.', footer), 401);
    const headers = new Headers();
    for (const h of ['range', 'if-range']) { const v = request.headers.get(h); if (v) headers.set(h, v); }
    if (url.searchParams.get('inline') === '1') headers.set('x-inline', '1'); // the hub still decides: safe types only
    // The user's own Durable Object: an id from someone else's hub can never resolve here.
    return hub(env, session.userId).fetch(new Request(`https://hub/file/${fileId}`, { method: request.method, headers }));
  }

  const viewId = parseViewPath(url.pathname);
  if (viewId && request.method === 'GET') {
    if (!session) return set.hidden ? notFound() : html(messagePage('Sign in at the dashboard first, then open this link again.', footer), 401);
    const stub = hub(env, session.userId);
    const files = await fetchFiles(stub, (await stub.status()).online);
    const me = files.items.find((x) => x.id === viewId);
    if (!me) return html(messagePage(files.ok ? 'This file is not shared (any more).' : (files.error ?? 'Files are unavailable.'), true), 404);
    if (viewKind(me.name) !== 'image') return Response.redirect(`${url.origin}/f/${encodeURIComponent(me.id)}/${encodeURIComponent(me.name)}?inline=1`, 302);
    const car = carouselOf(files.items, viewId)!;
    return html(viewerPage(car.items, car.index));
  }

  // /dashboard opens Setup until a token exists, Machines while no machine is connected and nothing is shared, else Files.
  if (url.pathname === '/dashboard' && request.method === 'GET') {
    if (!session) return signedOut();
    const [tokens, status] = await Promise.all([listTokens(env, session.userId), hub(env, session.userId).status()]);
    const to = defaultSection({ tokens: tokens.length, online: status.online, files: 0 });
    return Response.redirect(`${url.origin}${SECTIONS.find((x) => x.id === to)!.path}`, 302);
  }

  const sec = sectionFor(url.pathname);
  if (sec && request.method === 'GET') {
    if (!session) return signedOut();
    if (sec.ownerOnly && !isOwner(env, session.userId)) return notFound();
    const q = url.searchParams;
    const extra = sec.id === 'files'
      ? { flash: DONE[q.get('done') ?? ''], confirmId: q.get('revoke') ?? undefined, confirmGroup: q.get('revoke_group') ?? undefined }
      : {};
    return dashboardResponse(env, url.origin, session, sec.id, set, extra);
  }
  if (url.pathname.startsWith('/dashboard/') && request.method === 'POST') {
    // CSRF: same-origin form posts only (plus SameSite=Lax session cookie).
    if (request.headers.get('origin') !== url.origin) return new Response('cross-site request refused', { status: 403 });
    if (!session) return set.hidden ? notFound() : Response.redirect(`${url.origin}/dashboard`, 303);
    const form = await request.formData();
    if (url.pathname === '/dashboard/tokens') {
      const token = await createToken(env, session.userId, String(form.get('label') ?? ''));
      return dashboardResponse(env, url.origin, session, 'machines', set, { newToken: token });
    }
    if (url.pathname === '/dashboard/revoke') {
      await revokeToken(env, session.userId, String(form.get('id')));
      return Response.redirect(`${url.origin}/dashboard/machines`, 303);
    }
    if (url.pathname === '/dashboard/files/revoke') {
      const id = String(form.get('id') ?? ''), group = String(form.get('group') ?? '');
      const stub = hub(env, session.userId);
      const done = /^[\w][\w .-]{0,59}$/.test(group) ? ((await revokeFiles(stub, { group })) ? 'group' : 'failed')
        : /^[A-Za-z0-9_-]{8,64}$/.test(id) ? ((await revokeFiles(stub, { id })) ? 'revoked' : 'failed') : 'failed';
      return Response.redirect(`${url.origin}/dashboard/files?done=${done}`, 303);
    }
    if (url.pathname === '/dashboard/settings') {
      if (!isOwner(env, session.userId)) return notFound();
      const loginPath = form.get('action') === 'generate' ? generateLoginPath() : String(form.get('login_path') ?? '');
      const v = validateChange({ landing: form.get('landing') === '1', loginPath });
      if (!v.ok) return dashboardResponse(env, url.origin, session, 'settings', set, { settingsError: v.error, status: 400 });
      await env.OAUTH_KV.put(SETTINGS_KEY, JSON.stringify(v.stored));
      console.log('settings changed');
      return dashboardResponse(env, url.origin, session, 'settings', resolveSettings(env, v.stored), { flash: 'Saved. It applies within about a minute.' });
    }
    if (url.pathname === '/dashboard/logout') {
      return new Response(null, { status: 303, headers: { location: '/dashboard', 'set-cookie': setCookie(SESSION, '', 0) } });
    }
    return Response.redirect(`${url.origin}/dashboard`, 303);
  }
  return notFound();
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return html(messagePage(error instanceof AuthorizationError ? error.description ?? 'Authorization failed.' : 'This app could not be verified.'), 400);
      }
      console.error(error);
      return html(messagePage('Something went wrong. Please try again.'), 500);
    }
  },
};

// The resource URL depends on the host (workers.dev now, a custom domain later), so build per origin.
const providersByOrigin = new Map<string, OAuthProvider<Env>>();
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = new URL(request.url).origin;
    let p = providersByOrigin.get(origin);
    if (!p) {
      p = new OAuthProvider<Env>({
        apiRoute: '/mcp',
        apiHandler: mcpApi as never,
        defaultHandler: defaultHandler as never,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/token',
        clientRegistrationEndpoint: '/register',
        scopesSupported: [SCOPE],
        requiredScopes: [SCOPE],
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      } as never);
      providersByOrigin.set(origin, p);
    }
    return p.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
