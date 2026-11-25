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

## 2. File handoff (DECIDED by Adel; being built on feature/file-handoff)

Decisions
- No cloud copies: bytes stream hub -> worker over the existing agent WebSocket, never stored (no R2/KV).
- Authenticated exactly like the dashboard: session cookie (GitHub/Google sign-in, allowlisted). Never public, no bare links.
- Lives in the dashboard: a "Files" section (name, size, expiry, Download, Revoke).
- MCP tools: `file_share(path, ttl_minutes)`, `file_list`, `file_revoke`.
- Limits: allowed roots only (FILE_SHARE_ROOTS, default none = refuse), no dotfiles/.env anywhere in the path,
  size cap (FILE_SHARE_MAX_MB, default 1024), expiry default 30 min, max 24 h, Range/resume.

Mechanism
- Hub keeps a `shares` table (id, path, name, size, created, expires, revoked). Id = random 128-bit.
- URL: `https://<worker>/f/<id>/<name>`. Worker checks the session cookie, then asks that user's Durable Object
  (per-user, so the id only resolves in the owner's hub). No cookie = 401 page, never the file.
- Worker -> agent: `{type:'file', id, share, range, ifRange, head}`. Agent -> worker: JSON `file-head`
  (status + headers, Range parsed on the hub), binary frames (36-byte request id + payload), JSON `file-end`/`file-error`.
- Backpressure: agent sends at most 4 MB unacked; the worker acks as the client reads. Client abort -> `cancel`.
- Hub re-validates at download time: realpath still under a root, not dotfile, not revoked/expired, size cap.
  Revoke also aborts running downloads. Always `application/octet-stream` + attachment + nosniff.
- Phone: Chrome signs in once and resumes with Range. 1DM/ADM need their built-in browser to sign in.

Open notes for Adel
- Cookie lasts 7 days and is not re-checked against the allowlist per request (same as the dashboard today).
- Only files on the hub itself (the agent's machine), not other machines.
- Cloudflare limits on very long streams are untested until deployed.

### Viewer, groups, default tab (DECIDED by Adel, built)
- Inline view (`?inline=1`): images, PDF, plain text only, by extension, enforced on the hub and again on the Worker; HTML/SVG never.
  Images open in `/view/<id>`: 100% (CSS size = natural / devicePixelRatio), fit toggle, carousel over the group (arrows, keys, swipe at the image edge).
- `file_share(..., group?, label?)`; the dashboard groups files, sub-headings by label; "View all", "Delete group" with a confirm page.
  Revoke of one file also goes through a confirm page. Sharing the same path again updates group/label/expiry.
- `/dashboard` redirects: no tokens -> Setup; tokens but agent offline and nothing shared -> Machines; else Files. Nav: Files, Setup, Machines, Settings.

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

## 4. Dashboard UI revamp (DECIDED by Adel; built on feature/file-handoff, mockup below)
Plain server-rendered HTML/CSS in worker/src/pages.ts, no framework, no client JS. One page per section so every
section has its own URL (works without JS, easy to link). Light/dark via prefers-color-scheme.

Sections (each a small module: `{ id, title, render(ctx) }` in a list; adding Users or Approvals later = one entry)
- Setup `/dashboard` (default): connector URL to copy, 3 getting-started steps, agent start command.
- Settings `/dashboard/settings` (owner-only): landing on/off and the secret login path (section 5).
- Machines `/dashboard/machines`: online status, create token (shown once), list and revoke tokens.
- Files `/dashboard/files`: shared files (name, size, expires in, Download, Revoke).
- Later: Users, Approvals (hidden until built; Users owner-only).

Desktop (sidebar):
```
+--------------------------------------------------+
| Session Orchestrator            adel  [Sign out] |
+-----------+--------------------------------------+
| > Setup   |  Setup                               |
|   Machines|  Connector URL                       |
|   Files   |  [ https://orch.example/mcp ] [Copy] |
|           |  Getting started                     |
|           |  1 Add the connector in Claude       |
|           |  2 Create a token under Machines     |
|           |  3 Start the agent on your machine   |
+-----------+--------------------------------------+
```
Mobile (<720px): sidebar becomes a horizontal tab strip under the header, single column, 16px gutters, 44px targets:
```
+------------------------------+
| Session Orchestrator  Sign out|
| [Setup] [Machines] [Files]  > |
|------------------------------|
| Machines                     |
| (o) home-server  online 2 h  |
|  token "home"  [Revoke]      |
|  [ label........ ][Create]   |
+------------------------------+
```
Files row: `report.pdf  4.2 MB  expires in 28 min  [Download] [Revoke]` (stacks on mobile).

## 5. Hide the public landing page + Settings (DECIDED by Adel; built on feature/file-handoff)
Dropped: changing the subdomain. The host stays orch.adelzu.com; only the path is configurable.
- Settings section in the dashboard, owner-only (`OWNER_IDS` env, user ids like github-123; none = no Settings).
- Stored in KV `cso:settings` {landing, loginPath}; env `PUBLIC_LANDING` / `LOGIN_PATH` are starting values; KV wins; live, no redeploy
  (KV edge cache: up to about a minute).
- Landing off: `/`, `/login` and unknown paths return a plain 404 with no links; sign-in only at the secret path (`<path>` page, `<path>/<provider>`).
  Dashboard and file links answer 404 without a session. Unchanged: `/mcp`, OAuth routes, `/callback`, `/agent`, `/privacy`
  (kept public as a legal page, without site links; Adel can decide to hide it too).
- Safety: login path = one segment, 8 to 64 chars, not a service name; landing off needs a login path, else the page stays shown (no lockout).
  Recovery: delete KV key `cso:settings`, set LOGIN_PATH.
- Note: `/authorize` (MCP consent) still shows provider buttons; the OAuth flow needs them.

## Open questions
See reply to Adel.
