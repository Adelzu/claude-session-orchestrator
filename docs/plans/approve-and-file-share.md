# Design notes (scratch, not an ADR): phone approval + file handoff

Status: exploration only. Nothing decided until Adel confirms.
Facts checked in code: server.ts serves `/mcp`, `/events` (POST, per-machine token), `/health`
on 127.0.0.1:8787; the Cloudflare worker fronts it (orch.adelzu.com). notify.sh posts hook JSON to /events.
No ntfy/Teams code exists today.

## 1. Approve from phone

Flow: Notification hook -> ingest() sets waiting_approval -> NEW notifier pushes to the phone ->
phone taps Approve/Deny -> NEW endpoint -> same code path as session_approve (yes/no) -> status updates.

Channel options
- A. ntfy with action buttons: simplest, push to phone, buttons are HTTP POSTs. Needs ntfy server or ntfy.sh topic.
  Prompt text leaves the box (to ntfy.sh unless self-hosted).
- B. Tiny web page on the orch server (behind the worker / Cloudflare Access): tap notification link, see prompt, press button.
  No third party sees the text. Needs some push channel to deliver the link anyway.
- C. Teams: heavier (bot/webhook), actionable cards need Azure setup. Not recommended.
- Recommended: B for the approve page + A (self-hosted or private topic) only to carry a link, no prompt text.

Approve endpoint `POST /approve/<id>`
- id = random 128-bit, created per pending approval, stored in DB with session, prompt hash, created, expires, used.
- One-time use (replay protection), expiry (suggest 10 min), reject if session no longer waiting_approval
  or the prompt changed (hash of last 12 pane lines) so a stale tap cannot approve a different prompt.
- Auth: link token alone is a bearer secret; add Cloudflare Access (existing CF_ACCESS_AUD) or require MCP_TOKEN on the page.
- Deny maps to session_approve choice=no. Audit line in the log (source=phone).

Prompt text shown: tool + command/file, project, machine, first ~300 chars, truncated, never secrets from env.

## 2. File handoff (DECIDED: always authenticated; REVISED: reuse the hub's existing sign-in, no separate password)

What the hub's login is (checked in code/.env): the Cloudflare Worker at orch.adelzu.com runs its own OAuth
(not Cloudflare Access; no CF_ACCESS_* in ~/orch-server/.env). GitHub sign-in with an ALLOWED_GITHUB_IDS allowlist
(Google is disabled). Browser session = HMAC-signed cookie `__Host-cso-session` (HttpOnly, Secure, SameSite=Lax) on
the worker origin; Claude connector uses OAuth 2.1 on /mcp. The hub agent dials OUT to the worker over a WebSocket
that carries only JSON tool calls. The hub itself only takes MCP_TOKEN/EVENTS_TOKEN on 127.0.0.1.

Design
- Download URL on the worker: `https://orch.adelzu.com/f/<token>/<name>`. Worker requires (1) a valid session cookie
  whose userId is allowlisted AND equals the file's owner, and (2) an unexpired per-file token (random 128-bit,
  default 30 min, max 24 h, optional one-time, revocable). No cookie = redirect to GitHub sign-in, never the file.
- Bytes: worker asks the user's hub agent for the byte range over the existing agent WebSocket (new chunked
  binary messages, Range-aware, backpressure); nothing stored in the cloud. Alternative: hub uploads to R2 (simple,
  fast, resumable by Cloudflare, but the file is copied to Cloudflare storage and needs size/cost limits).
- Approvals reuse the same cookie: `/approve/<id>` on the worker, same allowlist check, one-time id, expiry.
- Tool `file_share(path, ttl, one_time?)` -> URL (no secret in it). Allowed paths/denylist/size limit/list/revoke as before.

Phone
- Chrome: sign in once (cookie), its downloader sends cookies + Range, so resume works.
- 1DM/ADM: they do not carry Chrome's cookies. Use their built-in browser (sign in there, they then reuse the
  cookie and can resume), or download in Chrome. No separate password and no public link in either case.

Tradeoff: worker relay is new code and Cloudflare Worker CPU/duration/WebSocket limits may cap large files
(the mid-way resets could return); Tailscale-direct to the hub would avoid that but needs its own sign-in.

## 3. Admin panel for who may sign in (PROPOSAL, not decided)

Placement (Adel): a section/tab of the existing worker dashboard, owner-only, not a separate /admin app.
Dashboard today (worker/src/index.ts, pages.ts): `GET /dashboard` (signed-in page: agent online/offline + tools count,
agent tokens list/create/revoke, Claude connector URL, sign out) and `POST /dashboard/{tokens,revoke,logout}`.
It is a per-user token page, not a sessions dashboard. New: an "Users" section on /dashboard shown only when the
session userId is an owner, with `POST /dashboard/users/{add,remove}` using the same session cookie.

Today: the allowlist is the worker env var `ALLOWED_GITHUB_IDS` (comma-separated numeric GitHub ids), read in
`worker/src/identity.ts` `exchange()` (added in de93aa4). Set in the Cloudflare dashboard/secrets, not in
wrangler.jsonc; changing it means editing the var and redeploying/restarting. Google now has its own allowlist, `ALLOWED_GOOGLE_EMAILS` (exact emails). The Users panel would manage both lists.

Google status (UPDATE: re-enabled in the working tree, uncommitted/undeployed, gated by ALLOWED_GOOGLE_EMAILS: exact lowercased
verified emails only, `email_verified` must be true, default deny when empty/unset; user id stays `google-<sub>`).
Rule (Adel): each provider (GitHub, Google) is enabled only when its client id AND secret are set; otherwise no button
and its routes refuse; none configured = sign-in page says not configured.
History: it had been deliberately disabled in code (commit de93aa4, Nov 19: "restrict sign-in to allowed GitHub IDs, disable
Google"). The Google token exchange was removed and `exchange()` throws "Google sign-in is disabled". Not a missing
flag; GOOGLE_CLIENT_ID/SECRET are still declared in Env and README. Kept for later, ignored for now. Re-enabling means
restoring that block plus an allowlist check (by `sub`/email).

Proposal: the Users section, visible only to an "owner" id (first allowed id / a separate OWNER_IDS var).
- List, add, remove allowed users (provider + stable id + label), show last sign-in, revoke their sessions/agent tokens.
- Storage options: (a) existing OAUTH_KV, key `cso:allow:<provider>-<id>`; simplest, already bound, eventually
  consistent (seconds). (b) D1: relational and auditable, but a new binding/migration. (c) hub DB: wrong place, the
  worker must work when the hub is offline. Leaning (a) KV; ALLOWED_GITHUB_IDS stays as the bootstrap owner list.
- Safety: owner cannot remove themselves/last owner; every change audit-logged; CSRF token on forms; adds need
  GitHub numeric id lookup by login (verify via api.github.com/users/<login>), so no typo'd ids.
- Open: roles (owner vs user), per-user hub isolation already exists (DO id per user), Google later.

## Sign-in lockdown (implemented in the working tree, uncommitted)
Providers enabled only when client id AND secret are set; per-provider allowlists (ALLOWED_GITHUB_IDS;
ALLOWED_GOOGLE_EMAILS, exact lowercased, email_verified true); default deny when empty; no provider configured = no
sign-in; unconfigured provider routes refuse before any provider call. Dashboard Users panel (section 3) is the planned
way to manage both lists. User docs: worker/README.md "Who can sign in".

## Open questions
See reply to Adel.
