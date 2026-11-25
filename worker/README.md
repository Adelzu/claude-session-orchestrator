# Hosted front door (Cloudflare Worker)

This Worker gives every user a Claude connector URL and a relay to their own agent:

- `/mcp` is a stateless MCP endpoint. OAuth 2.1 uses dynamic client registration and PKCE. Each tool call is forwarded to the signed-in user's own agent.
- `/authorize` shows the consent page, then signs the user in with GitHub or Google (PKCE upstream).
- `/dashboard` is where users sign in to create and revoke agent tokens. Only SHA-256 hashes of the tokens are stored.
- `/agent` is the WebSocket the user's agent dials out to, authenticated with an agent token.
- `/privacy` is the privacy policy page.

A user's Durable Object id is derived only from their signed-in identity (`github-<id>` or `google-<sub>`), so one user can never reach another user's agent.

## Deploy

```sh
npm ci
npx wrangler login                       # or export CLOUDFLARE_API_TOKEN
npx wrangler kv namespace create OAUTH_KV # paste the id into wrangler.jsonc
npx wrangler secret put COOKIE_SECRET     # openssl rand -hex 32
npx wrangler secret put GITHUB_CLIENT_ID; npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID; npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

## Who can sign in

Sign-in is locked down in two layers. Both must pass.

1. **Providers are enabled only when fully configured.** GitHub needs `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`;
   Google needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. A provider missing either value has no sign-in button, and
   its authorize, login and callback routes refuse the request before any call to the provider. With no provider
   configured, the sign-in pages say sign-in is not configured and nobody can sign in.
2. **Per-provider allowlists, default deny.** Set these as Worker variables or secrets (comma-separated):
   - `ALLOWED_GITHUB_IDS`: numeric GitHub user ids. Empty or unset: nobody signs in with GitHub.
   - `ALLOWED_GOOGLE_EMAILS`: exact email addresses, compared lowercased. Google must also report `email_verified: true`.
     Unverified, unlisted, or missing emails are denied. Empty or unset: nobody signs in with Google.

A user's identity is `github-<id>` or `google-<sub>`, never an email, so renaming an account cannot move anyone
into another tenant. The lists are read on every sign-in; changing one needs no redeploy of code, only the variable.

Planned (a proposal, not built): an owner-only "Users" section in the dashboard to add and remove people on both lists
instead of editing variables. See `docs/plans/approve-and-file-share.md`.

The OAuth apps' callback URL is `https://<worker-host>/callback`, for both GitHub and Google.

## Develop

```sh
printf 'DEV_LOGIN=1\nCOOKIE_SECRET=%s\n' "$(openssl rand -hex 32)" > .dev.vars
npx wrangler dev --port 8788 --ip 127.0.0.1
node test/e2e.mjs   # sign-in, agent link, tool relay, tenant isolation, revocation
```

`DEV_LOGIN` turns on a fake sign-in, and only for `localhost` requests. Never set it as a deployed variable or secret.
