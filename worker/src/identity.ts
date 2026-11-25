// Upstream sign-in: GitHub and Google (OAuth 2.0 + PKCE). The user id is `<provider>-<stable id>`,
// never an email, so an account rename or email change cannot move someone into another tenant.
import type { Env } from './index.ts';

export type Provider = 'github' | 'google' | 'dev';
export interface Identity { userId: string; name: string }

export const s256 = async (verifier: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const callbackUrl = (req: Request) => `${new URL(req.url).origin}/callback`;

/** Dev sign-in exists only for `wrangler dev` on localhost with DEV_LOGIN=1 (set in .dev.vars, never deployed). */
export const devLoginAllowed = (req: Request, env: Env) =>
  env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);

/** Comma-separated allowlist -> trimmed non-empty entries; `lower` for case-insensitive values such as emails. */
const list = (v: string | undefined, lower = false) => (v ?? '').split(',').map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter(Boolean);

/** A provider exists only when BOTH its client id and client secret are set. */
export const githubEnabled = (env: Env) => !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET;
export const googleEnabled = (env: Env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;

export function providers(req: Request, env: Env): Provider[] {
  const list: Provider[] = [];
  if (githubEnabled(env)) list.push('github');
  if (googleEnabled(env)) list.push('google');
  if (devLoginAllowed(req, env)) list.push('dev');
  return list;
}

export async function authorizeUrl(provider: Provider, req: Request, env: Env, state: string, verifier: string, devUser = 'local') {
  const challenge = await s256(verifier);
  const redirect = callbackUrl(req);
  if (provider === 'github') {
    if (!githubEnabled(env)) throw new Error('sign-in provider github is not configured');
    const u = new URL('https://github.com/login/oauth/authorize');
    u.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: redirect, scope: 'read:user', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'true' }).toString();
    return u.toString();
  }
  if (provider === 'google') {
    if (!googleEnabled(env)) throw new Error('sign-in provider google is not configured');
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return u.toString();
  }
  if (provider === 'dev' && devLoginAllowed(req, env)) return `${redirect}?code=dev.${devUser.replace(/[^a-z0-9]/g, '') || 'local'}&state=${encodeURIComponent(state)}`;
  throw new Error(`sign-in provider ${provider} is not configured`);
}

/** Exchange the provider's code and return a stable identity. Throws on any failure. */
export async function exchange(provider: Provider, req: Request, env: Env, code: string, verifier: string): Promise<Identity> {
  const redirect = callbackUrl(req);
  if (provider === 'github') {
    if (!githubEnabled(env)) throw new Error('sign-in provider github is not configured'); // never reaches the token exchange
    const t = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirect, code_verifier: verifier }),
    }).then((r) => r.json()) as { access_token?: string; error?: string };
    if (!t.access_token) throw new Error(`GitHub sign-in failed: ${t.error ?? 'no token'}`);
    const u = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${t.access_token}`, 'user-agent': 'claude-session-orchestrator', accept: 'application/vnd.github+json' },
    }).then((r) => r.json()) as { id?: number; login?: string };
    if (!u.id) throw new Error('GitHub sign-in failed: no user id');
    if (!list(env.ALLOWED_GITHUB_IDS).includes(String(u.id))) throw new Error('GitHub sign-in failed: user not allowed');
    return { userId: `github-${u.id}`, name: u.login ?? `github-${u.id}` };
  }
  if (provider === 'google') {
    if (!googleEnabled(env)) throw new Error('sign-in provider google is not configured'); // never reaches the token exchange
    const t = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code_verifier: verifier }),
    }).then((r) => r.json()) as { access_token?: string; error?: string };
    if (!t.access_token) throw new Error(`Google sign-in failed: ${t.error ?? 'no token'}`);
    const u = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } })
      .then((r) => r.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!u.sub) throw new Error('Google sign-in failed: no subject');
    // Default deny: only a verified email that is exactly on ALLOWED_GOOGLE_EMAILS (compared lowercased) gets in.
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
    if (u.email_verified !== true || !email || !list(env.ALLOWED_GOOGLE_EMAILS, true).includes(email)) throw new Error('Google sign-in failed: user not allowed');
    return { userId: `google-${u.sub}`, name: email };
  }
  if (provider === 'dev' && devLoginAllowed(req, env) && /^dev\.[a-z0-9]+$/.test(code)) return { userId: `dev-${code.slice(4)}`, name: `dev ${code.slice(4)}` };
  throw new Error('unknown sign-in provider');
}
