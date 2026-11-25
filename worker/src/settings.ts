// Owner-editable settings, stored in KV and applied live (no redeploy). Env vars are only the starting values.
//  - loginPath: the secret path where sign-in is reachable when the landing page is hidden.
//  - landing: whether the public landing page is shown.
// The hostname is fixed; only the path under it can change.

export interface Stored { landing?: boolean; loginPath?: string }
export interface Resolved {
  landing: boolean;            // configured: show the public landing page
  loginPath: string | null;
  hidden: boolean;             // effective: landing off AND a login path exists (never lock everybody out)
  source: { landing: 'kv' | 'env' | 'default'; loginPath: 'kv' | 'env' | 'none' };
}

export const SETTINGS_KEY = 'cso:settings';
// Paths the service itself uses; a login path may never shadow them.
const RESERVED = new Set(['dashboard', 'login', 'authorize', 'callback', 'token', 'register', 'agent', 'mcp', 'privacy', 'f', 'view', 'favicon.ico', 'robots.txt']);
const OFF = /^(0|off|false|no)$/i;

/** `/abc-12345` or `abc-12345` -> `/abc-12345`; one segment of 8 to 64 URL-safe characters, never a reserved name. */
export function normalizeLoginPath(input: string | undefined | null): string | null {
  const p = (input ?? '').trim().replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(p) || RESERVED.has(p.toLowerCase())) return null;
  return `/${p}`;
}

export function generateLoginPath(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `/${btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function resolveSettings(env: { PUBLIC_LANDING?: string; LOGIN_PATH?: string }, stored: Stored | null): Resolved {
  const kvPath = stored?.loginPath ? normalizeLoginPath(stored.loginPath) : null;
  const envPath = normalizeLoginPath(env.LOGIN_PATH);
  const loginPath = kvPath ?? envPath;
  const landing = typeof stored?.landing === 'boolean' ? stored.landing : env.PUBLIC_LANDING !== undefined ? !OFF.test(env.PUBLIC_LANDING.trim()) : true;
  return {
    landing, loginPath, hidden: !landing && !!loginPath,
    source: {
      landing: typeof stored?.landing === 'boolean' ? 'kv' : env.PUBLIC_LANDING !== undefined ? 'env' : 'default',
      loginPath: kvPath ? 'kv' : envPath ? 'env' : 'none',
    },
  };
}

/** Validate what the owner submitted. Hiding the landing page needs a login path, or nobody could sign in. */
export function validateChange(input: { landing: boolean; loginPath: string }): { ok: true; stored: Stored } | { ok: false; error: string } {
  const raw = input.loginPath.trim();
  const loginPath = raw ? normalizeLoginPath(raw) : null;
  if (raw && !loginPath) return { ok: false, error: 'The login path must be one segment of 8 to 64 letters, digits, - or _, and not a name the service uses.' };
  if (!input.landing && !loginPath) return { ok: false, error: 'Hiding the landing page needs a login path, or nobody could sign in.' };
  return { ok: true, stored: { landing: input.landing, ...(loginPath ? { loginPath } : {}) } };
}

export type PublicRoute =
  | { kind: 'home' } | { kind: 'privacy' } | { kind: 'login-page' } | { kind: 'login-start'; provider: string }
  | { kind: 'legacy-login' } | { kind: 'not-found' } | null;

/** The public, session-less pages and how settings change them. null = not decided here (OAuth, dashboard, agent, ...). */
export function publicRoute(pathname: string, s: Resolved): PublicRoute {
  if (s.loginPath) {
    if (pathname === s.loginPath) return { kind: 'login-page' };
    if (pathname.startsWith(`${s.loginPath}/`)) return { kind: 'login-start', provider: pathname.slice(s.loginPath.length + 1) };
  }
  if (pathname === '/') return s.hidden ? { kind: 'not-found' } : { kind: 'home' };
  if (pathname === '/privacy') return { kind: 'privacy' };
  if (pathname === '/login') return s.hidden ? { kind: 'not-found' } : { kind: 'legacy-login' };
  return null;
}
