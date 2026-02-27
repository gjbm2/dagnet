# Git Authentication: Per-User OAuth Design

**Status:** Macro A complete. Macro B (migration to read-only base token) not yet started.
**Date:** 24-Feb-26
**GitHub App:** `dagnet-vercel` (App ID 2955768, Client ID `Iv23liF1oQ3LM14TiZ7A`)
**A1 verified:** Full OAuth round trip on production
**A2 verified:** Token persisted to IDB, credential reload works, chip shows @username
**A4:** Deployment guide written at `graph-editor/public/docs/deployment-github-auth.md`

## Problem

Currently, all DagNet users share a single GitHub PAT (stored in the Vercel env credentials). This works, but:

- All commits are attributed to the token owner's GitHub identity
- There's no distinction between users with read vs write intent
- The shared token has full repo write access, which is broader than needed for read-only users

## Goal

Move to a two-tier model where:

1. **All users** get read access via a shared read-only token (from env credentials)
2. **Collaborators** connect their own GitHub account for write access via OAuth

## Architecture Overview

```
Vercel env vars (build-time)
  └── Base credentials: repo identity, paths, Amplitude keys, READ-ONLY git token
        │
        ▼
  User initialises (enters secret)
  └── Base config copied to IndexedDB → user can READ
        │
        ▼
  User clicks "Connect GitHub" (optional)
  └── OAuth token stored alongside base config → user can WRITE (if collaborator)
```

## Typical User Journey

1. User receives a link to DagNet (the Vercel-hosted URL)
2. They open it — blank slate, no credentials
3. They retrieve the shared init secret from 1Password (or equivalent) and enter it in the init modal
4. Base credentials load from Vercel env — repo identity, Amplitude config, read-only git token
5. User can browse the workspace (read-only): view graphs, pull latest, inspect data
6. They see the "read-only 🔗" chip in the menu bar — click it
7. Browser redirects to GitHub — they log in with their own GitHub account and authorise the DagNet GitHub App
8. Redirected back to DagNet — their personal OAuth token is stored in IndexedDB
9. If they're a collaborator on the repo, they now have full write access (push, commit). If not, write operations fail with a clear message directing them to request collaborator access from the repo owner.

Steps 1–5 are the existing flow (unchanged except the token becomes read-only). Steps 6–9 are the new OAuth layer.

## Current Credential Flow (unchanged parts)

The existing blank-slate initialisation stays as-is:

1. App loads → IndexedDB empty → welcome screen
2. User clicks "Initialize from server secret" and enters the shared secret
3. `VITE_INIT_CREDENTIALS_JSON` is copied into IndexedDB
4. Workspace reloads — repo identity, branch, paths, and Amplitude config are now known
5. User can browse the workspace

This flow provides the **base configuration**: repo identity (`owner`, `name`), branch, directory paths (`graphsPath`, `paramsPath`), and provider credentials (Amplitude). None of this changes.

### What changes in the base config

The git token in `VITE_INIT_CREDENTIALS_JSON` changes from a full-access PAT to a **fine-grained PAT with read-only Contents permission** on the target repo. This is the only change to the existing credential pipeline.

## OAuth Layer (new)

### GitHub App Registration (one-time setup)

1. Register a GitHub App at `github.com/settings/developers` (see Phase A0a for detailed steps)
2. Add callback URLs for production and preview deploys
3. Store `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` as Vercel environment variables
4. Expose the client ID to the client via `VITE_GITHUB_OAUTH_CLIENT_ID`

### User Flow

After the user has initialised with base credentials (step 4 above), a "Connect GitHub" option appears in the UI — e.g. in the menu bar or as a banner.

1. User clicks "Connect GitHub"
2. Browser redirects to `https://github.com/login/oauth/authorize?client_id=<id>&redirect_uri=https://<domain>/api/auth-callback` (no `scope` parameter — permissions are defined on the GitHub App itself)
3. GitHub shows authorisation prompt → user approves
4. GitHub redirects to the Vercel serverless callback with a temporary `code`
5. Serverless function exchanges the code for an access token (server-side, client secret never exposed)
6. Serverless function redirects back to DagNet with the token (via URL parameter or `postMessage`)
7. Client writes the OAuth token and username directly into the existing credentials file (`git[0].token` and `git[0].userName`), then triggers a credential reload
8. On subsequent loads, the credentials file already contains the user's OAuth token — no special handling needed

### Serverless Callback Function

New file: `graph-editor/api/auth-callback.ts`

Responsibilities:
- Receive the `code` parameter from GitHub's redirect
- POST to `https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, and `code`
- Receive the `access_token` in the response
- Redirect back to the app origin with the token

The client secret (`GITHUB_OAUTH_CLIENT_SECRET`) lives only in the Vercel env — never sent to the browser.

### Token Storage

The OAuth token is written directly into the existing credentials file (`credentials-credentials` in IndexedDB), updating the `token` and `userName` fields on the **currently selected repo's** git entry. Other repos in the credentials file are unaffected. No separate storage, no merging logic, no changes to `credentialsManager`. The existing credential loading path works unchanged.

The "read-only 🔗" chip is **repo-aware** — it reflects whether the currently selected repo has an OAuth token or the shared PAT. Switching repos may change the chip state.

Disconnecting means the user re-initialises from the shared secret (same flow as first-time setup), which replaces the entire credentials file with the base config including shared tokens for all repos.

### Token Characteristics

- **Permissions:** Fine-grained — only Contents read/write on repos where the app is installed (much narrower than an OAuth App's broad `repo` scope)
- **Lifetime:** With "Expire user authorisation tokens" unchecked on the GitHub App, tokens don't expire unless the user revokes them or they go unused for 1 year
- **Storage:** Written into the existing credentials file in IndexedDB (`git[0].token`), per-browser — clearing browser data requires re-authentication
- **Attribution:** Commits made with the user's token are attributed to their GitHub identity

## Two-Tier Access Model

| State | Token used | Capabilities |
|---|---|---|
| After init, no OAuth | Read-only PAT from env | Browse files, view graphs, pull latest |
| After "Connect GitHub" | User's own OAuth token | Full read/write — push, commit (if collaborator on repo) |

### Non-Collaborator Handling

If a user connects their GitHub account but isn't a collaborator on the target repo:

- Their OAuth token authenticates successfully (it's valid for their account)
- Read operations work (public repos) or may fail (private repos without access)
- Write operations return HTTP 403 from GitHub
- DagNet catches this and displays a message: "You don't have write access to this repository. Ask the repo owner to add you as a collaborator."

Collaborator invitations are handled outside DagNet — the repo owner adds collaborators via GitHub's settings UI.

## Implementation Plan

### Risk profile

The code is simple. The risk is **operational configuration**: getting the GitHub App, callback URLs, env vars, and token scopes correct and aligned. The failure mode isn't "the code has a bug" — it's "deploy, discover a wiring issue, fix, redeploy, discover another, fix, redeploy" for hours.

The plan is structured around two principles:
1. **Verify every configuration artifact before any deployment** — using `curl` and CLI, not deploying and hoping
2. **Two macro-phases with a clean boundary** — Macro A is purely additive (zero risk to existing users, can be reverted by removing FF); Macro B is the breaking migration (only attempted once Macro A is proven stable in production)

### Macro-phase structure

**Macro A — "Connect GitHub" as optional capability.** Additive. Existing users unaffected. The shared full-access PAT remains. OAuth is opt-in — users who connect get their personal token written into the credentials file, replacing the shared token. Shipped behind a feature flag, validated on production, then flag removed.

**Macro B — Cutover to read-only base token.** Breaking change. Swap the shared PAT to read-only, force migration for existing users, revoke old PAT. Only attempted after Macro A is stable in production.

---

## Macro A — Optional GitHub Connect

### A0. Configuration lockdown (no code, no deploys)

**Goal:** Create, verify, and document every token, credential, and env var **before writing any code**. When A1 deploys, the config should already be proven correct.

#### A0a. GitHub App registration

Register a **GitHub App** (not an OAuth App). GitHub Apps support **multiple callback URLs**, eliminating the need to swap URLs between preview and production. They also offer fine-grained permissions and optional token expiry control.

**Step-by-step:**

1. Go to `github.com` → Settings → Developer settings → GitHub Apps → "New GitHub App"

2. Fill in every field:

   **Basic info:**
   - **GitHub App name:** deployer's choice — must be globally unique on GitHub, visible to users on the authorisation prompt. (e.g. `DagNet - Acme Corp`, `DagNet Prod`). Each DagNet deployment registers its own GitHub App; the app name, client ID, and secret are deployment-specific and never appear in the DagNet codebase — they flow entirely through Vercel env vars.
   - **Description:** deployer's choice — shown to users during authorisation. Should identify the DagNet instance.
   - **Homepage URL:** the Vercel production URL for this deployment

   **Identifying and authorising users:**
   - **Callback URL:** `https://<vercel-production-domain>/api/auth-callback` — then click "Add Callback URL" and also add `https://<preview-domain>/api/auth-callback` (add more preview URLs later as needed)
   - **Expire user authorisation tokens:** **uncheck**. Tokens will not expire. No refresh token logic needed.
   - **Request user authorization (OAuth) during installation:** **unchecked** (users authorise via the "read-only 🔗" chip in-app, not during app installation)
   - **Enable Device Flow:** **unchecked**

   **Post installation:**
   - **Setup URL:** leave blank
   - **Redirect on update:** **unchecked**

   **Webhook:**
   - **Active:** **uncheck** (DagNet doesn't need webhook events — this removes the requirement to fill in Webhook URL and Secret)

   **Repository permissions** (set exactly one, leave everything else at default `No access`):

   | Permission | Access | Why |
   |---|---|---|
   | Contents | **Read and write** | Tree listing, blob reads, ref lookups, commits, pushes |
   | Actions | No access | |
   | Administration | No access | |
   | Artifact metadata | No access | |
   | Attestations | No access | |
   | Checks | No access | |
   | Code scanning alerts | No access | |
   | Codespaces | No access | |
   | Codespaces lifecycle admin | No access | |
   | Codespaces metadata | No access | |
   | Codespaces secrets | No access | |
   | Commit statuses | No access | |
   | Custom properties | No access | |
   | Dependabot alerts | No access | |
   | Dependabot secrets | No access | |
   | Deployments | No access | |
   | Discussions | No access | |
   | Environments | No access | |
   | Issues | No access | |
   | Merge queues | No access | |
   | Metadata | Read (auto-granted when Contents is set) | |
   | Packages | No access | |
   | Pages | No access | |
   | Projects | No access | |
   | Pull requests | No access | |
   | Repository security advisories | No access | |
   | Secret scanning alert dismissal requests | No access | |
   | Secret scanning alerts | No access | |
   | Secret scanning push protection bypass requests | No access | |
   | Secrets | No access | |
   | Single file | No access | |
   | Variables | No access | |
   | Webhooks | No access | |
   | Workflows | No access | |

   **Organisation permissions:** all at `No access`
   **Account permissions:** all at `No access`

   **Subscribe to events:**
   - **All unchecked** (Installation target, Meta, Security advisory — none needed)

   **Where can this GitHub App be installed?**
   - **Any GitHub account** — required so that collaborators (with their own GitHub accounts) can authorise the app. "Only on this account" causes a 404 for other users.

3. Click "Create GitHub App"
4. On the app page: note the **Client ID** (shown immediately)
5. Click "Generate a new client secret" — note the **Client secret** (shown once, save it now)
6. Under **Optional features**, find **User-to-server token expiration** and click **Opt-out** (so tokens don't expire)

#### A0a.2. Install the GitHub App on the target repos

**This step is required.** A registered GitHub App can only access repos where it is installed. Without installation, user tokens (`ghu_`) will get 404 on all repo API calls.

1. Go to `https://github.com/apps/<your-app-name>` (the app's public page)
2. Click **Install**
3. Choose the account that owns the target repository
4. Select **"Only select repositories"** and pick the graph repo(s) that DagNet users will access
5. Click **Install**

This grants the app (and therefore all user tokens issued by it) access to the selected repos with the permissions configured in A0a (Contents: Read and write).

**No localhost callback URL.** Local dev (`npm run dev` via Vite on port 5173) doesn't serve serverless functions — files in `graph-editor/api/` only run on Vercel. The dev setup (`./dev-start.sh`) runs Vite + Python in tmux; Vite only proxies `/api/das-proxy` and `/api/github-proxy` via custom middleware. The callback cannot be tested locally.

**Callback URL management:** Because GitHub Apps support multiple callback URLs, register both the production URL and preview deploy URLs simultaneously. No swapping needed between environments. When a new preview URL is generated, add it to the list (takes 10 seconds in GitHub App settings). Old preview URLs can be removed when no longer needed.

Record in a single table:

| Artefact | Value | Where it's used |
|---|---|---|
| GitHub App client ID | `<value>` | Browser (`VITE_GITHUB_OAUTH_CLIENT_ID`) — same across all environments |
| GitHub App client secret | `<value>` | Vercel serverless only (`GITHUB_OAUTH_CLIENT_SECRET`) — same across all environments |
| Callback URL (prod) | `https://<prod-domain>/api/auth-callback` | Registered on GitHub App |
| Callback URL (preview) | `https://<preview-domain>/api/auth-callback` | Added to GitHub App when preview URL is known |

#### A0b. Verify the GitHub App works (no deploy, no code)

Do a **manual OAuth round trip using only `curl`** to prove the app registration, client ID, and secret are correct before any Vercel involvement:

1. Open in browser: `https://github.com/login/oauth/authorize?client_id=<id>&redirect_uri=https://<vercel-domain>/api/auth-callback&state=test1` (no `scope` — permissions are set on the GitHub App)
2. Authorise → GitHub redirects to `https://<vercel-domain>/api/auth-callback?code=<code>&state=test1` (this will 404 — the callback function isn't deployed yet. That's fine — grab the `code` from the URL bar before the page finishes loading)
3. Exchange the code via curl:
   ```
   curl -X POST https://github.com/login/oauth/access_token \
     -H "Accept: application/json" \
     -d "client_id=<id>&client_secret=<secret>&code=<code>"
   ```
4. Verify: response contains `access_token`
5. Verify: `curl -H "Authorization: token <access_token>" https://api.github.com/user` returns the expected user
6. Verify: token can read and write the target repo (for a collaborator account)

If any step fails, fix the GitHub App config before proceeding. **Do not write code until this works.**

#### A0c. Set Vercel env vars now

| Env var name | Runtime | Vercel scope | Value source |
|---|---|---|---|
| `VITE_GITHUB_OAUTH_CLIENT_ID` | Browser (build-time) | Preview + Production | GitHub App client ID from A0a |
| `GITHUB_OAUTH_CLIENT_SECRET` | Serverless only | Preview + Production | GitHub App client secret from A0a |

Set these **now**, for both Preview and Production scopes. They're inert until the callback function is deployed. Setting them now avoids a "forgot to set the env var" redeploy cycle later. No other env vars change — `VITE_INIT_CREDENTIALS_JSON` keeps the existing full-access PAT throughout all of Macro A.
  

---

### A1. Callback + bare round trip (one deploy to preview)

**Goal:** Prove the deployed OAuth round trip works. Because the config is already verified (A0b), this should work on the first deploy. If it doesn't, the issue is in the ~50 lines of callback code, not the config.

#### Build

Existing serverless functions in this project are flat files in `graph-editor/api/` (e.g. `das-proxy.ts`, `graph.ts`, `init-credentials.ts`). Vercel auto-discovers them by file path — no `vercel.json` config needed for TS functions.

The existing functions use the **deprecated** `@vercel/node` handler signature (`export default async function handler(req: VercelRequest, res: VercelResponse)`). New functions should use the **current Vercel Web Standard signature** — named HTTP method exports with standard `Request`/`Response` objects, no `@vercel/node` dependency:

```typescript
export function GET(request: Request) {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

New file: `graph-editor/api/auth-callback.ts` → deployed as `/api/auth-callback`

Exports a `GET` handler (GitHub redirects via GET with `code` and `state` as query params). Returns a **302 redirect** via `Response.redirect()`.

Responsibilities:
- Receives `code` and `state` from `request.url` query params
- POSTs to `https://github.com/login/oauth/access_token` with `client_id` (from `process.env.VITE_GITHUB_OAUTH_CLIENT_ID`), `client_secret` (from `process.env.GITHUB_OAUTH_CLIENT_SECRET`), and `code`
- Calls `GET https://api.github.com/user` with the resulting token to fetch the username
- Returns `Response.redirect(appOrigin + '?github_token=...&github_user=...&state=...', 302)`
- Error cases redirect back with an error query parameter instead
- Note: the `redirect_uri` must **exactly match** one of the callback URLs registered on the GitHub App — full path, not just domain

New file: `graph-editor/api/auth-status.ts` → deployed as `/api/auth-status`

Exports a `GET` handler returning JSON indicating which OAuth env vars are present (not their values — just `"set"` / `"not set"`). Used to verify env var wiring on any deploy without touching OAuth.

#### Deploy and test

- Push the branch → Vercel preview deploy
- Add the preview domain as a callback URL on the GitHub App if not already added (GitHub settings → GitHub Apps → DagNet → "Add Callback URL": `https://<preview-domain>/api/auth-callback`). No need to remove the production URL — both coexist.
- Hit `/api/auth-status` — confirm both env vars show as set
- Construct the authorise URL manually (same as A0b step 1, but with `redirect_uri` pointing at the preview)
- Walk through the OAuth flow in the browser
- Verify: browser lands back with a valid token in query params
- Verify: token works (`curl` checks as in A0b steps 5–6)

**Gate:** this should work first time. If not, `/api/auth-status` + Vercel function logs isolate the issue immediately.

---

### A2. Full wiring + UI (one more deploy to preview)

**Goal:** Wire the token into the credential system, add UI, and prove that a real OAuth-obtained token results in working git operations inside DagNet. This is where code changes to the app itself happen.

#### Build

**OAuth return handler** (`AppShell.tsx` or dedicated component): on app load, check URL for `?github_token=...&github_user=...&state=...` params from the callback. Validate `state` against `sessionStorage`. Write the token and username into the **currently selected repo's** git entry in the credentials file (matching by repo name), using the same `fileRegistry` pattern as the init-from-secret flow. Clean URL via `replaceState`. Trigger credential reload via `navOperations.reloadCredentials()`. No changes to `credentialsManager` or `appDatabase`.

**OAuth trigger** (`githubOAuthService.ts`): `startOAuthFlow()` generates `state`, stores in `sessionStorage`, redirects to GitHub's authorize URL using `VITE_GITHUB_OAUTH_CLIENT_ID` from env.

**Menu bar chip** (`RepositoryMenu.tsx` / `MenuBar.tsx`): "read-only 🔗" (clickable amber chip, tooltip: "Click to connect your GitHub account for write access") when no OAuth token. "@username" when connected; click opens popover with "Disconnect GitHub." Replaces the existing passive "read-only" badge.

**Disconnect**: user re-initialises from the shared secret (same as first-time setup), which replaces the credentials file with the base config including the shared token. No new code needed.

**Deferred to post-A2 polish (not blocking core flow):**
- Credentials form banner (banner at top of credentials editor when no OAuth token)
- Post-init toast (one-time toast after first secret-based init, pointing to the chip)
- Non-collaborator 403 handling (errors already surface via git API error messages; a friendlier message can be added later)

Feature-flag all new UI behind `?oauth=1` URL param.

#### Deploy and test on preview

- Deploy to preview (same branch as A1)
- Open with `?oauth=1`
- Init with secret → base credentials load
- Click "read-only 🔗" → full OAuth round trip → token stored → chip shows "@username"
- **Git operations**: pull latest, edit a file, commit and push. Verify push succeeds. Verify commit attributed to the OAuth user's GitHub identity.
- Disconnect → verify revert to shared token → push still works (existing full-access PAT)
- Reconnect → verify OAuth token used again
- **Two accounts**: collaborator (push succeeds), non-collaborator (push 403 with clear message)
- **Without `?oauth=1`**: everything behaves exactly as today — no chip, no OAuth, no changes

**Gate:** full round trip works, git operations work with the OAuth token, disconnect/reconnect cycle works, no regressions without the flag.

---

### A3. Feature-flagged production deploy (one deploy to prod)

**Goal:** Validate on the real production domain.

#### Pre-deploy verification (no deploy yet)

- Confirm the production callback URL is registered on the GitHub App (it should already be there from A0a — both preview and production URLs coexist).
- Hit `/api/auth-status` on the current production deploy — env vars should already be set (they were set in A0c, inert since then). If not, set them now (env-var-only, no code redeploy)

#### Deploy

- Deploy the feature branch to production (same code that passed A2)
- `VITE_INIT_CREDENTIALS_JSON` is **unchanged** — existing full-access PAT — existing users are completely unaffected
- Feature flag (`?oauth=1`) gates all new UI

#### Test on production

- Hit `/api/auth-status` — confirm env vars set
- With `?oauth=1`: full OAuth round trip on the production domain, git operations with OAuth token, disconnect/reconnect, collaborator vs non-collaborator
- **Without `?oauth=1`**: confirm existing users see zero changes

**Gate:** this should work first time (same GitHub App, same secrets, same code as A2 preview, production callback URL already registered). If not, the issue is isolated to the prod domain redirect — check callback URL registration.

---

### A4. Deployment guide (no deploy)

**Goal:** Write the standalone deployment guide before removing the feature flag, so the documentation is ready before the feature goes live.

New file: `graph-editor/public/docs/deployment-github-auth.md`

This is a step-by-step guide for **anyone deploying their own DagNet instance** to set up GitHub authentication. It covers:
- Why a per-deployment GitHub App is needed (callback URLs are domain-specific)
- Registering a GitHub App (field-by-field, mirroring A0a but written as deployer instructions)
- Creating a read-only PAT for the shared base credentials
- Setting Vercel env vars
- Adding collaborators to the target repo
- Verifying the setup using `/api/auth-status` and a manual OAuth round trip
- Troubleshooting common issues (wrong callback URL, missing env vars, 403 on push)

Also update:
- The project **README.md** — reference the deployment guide under a "GitHub Authentication" section. The README currently documents `VITE_GITHUB_TOKEN` and `setup.sh` env var prompts; these need updating to reflect the new OAuth model.
- **`setup.sh`** — if it prompts for `VITE_GITHUB_TOKEN`, update to prompt for the new OAuth env vars instead (or note that they're set in Vercel, not locally).
- **`.env.example`** — already updated with placeholder vars (done in A0c).

---

### A5. Remove feature flag (one more deploy to prod)

**Goal:** Make "Connect GitHub" available to all users.

- Remove the `?oauth=1` gate from the code
- Deploy to production
- The "read-only 🔗" chip now appears for all users who have base credentials but no OAuth token
- Existing behaviour is unchanged — the shared PAT still works for everyone, OAuth is purely opt-in
- Monitor: Vercel function logs for callback errors, session logs for OAuth-related events

**This is a safe, reversible step.** If anything goes wrong, revert the deploy — users who connected keep their token in IndexedDB (harmless), and the chip disappears. No data loss, no broken state.

---

## Macro B — Cutover to Read-Only Base Token

**Prerequisite:** Macro A is stable in production. Users have been connecting successfully. No operational issues.

**Approach:** Instead of a blocking migration modal, we handle invalid/revoked tokens gracefully. When the old PAT is revoked, users who haven't connected via OAuth will hit 401 errors. The app catches these and nudges them to connect. Users who already connected via OAuth are completely unaffected.

### B1. 401 handling and connect nudge (code changes + deploy)

**Goal:** Make the app handle invalid/revoked tokens gracefully so that revoking the old PAT is a smooth experience, not a broken one.

#### Current 401 behaviour (traced from code)

| Scenario | What user currently sees |
|---|---|
| Pull Latest | Toast: "Pull failed: Git API Error: 401 Unauthorized..." (raw, unhelpful) |
| Commit & Push | Raw error in commit modal |
| Initial clone (first load) | **Nothing visible** — console error, blank navigator |
| Workspace reload after cred change | **Nothing visible** — console error, possibly broken state |

The initial load case is the worst — a user whose PAT was just revoked sees a blank screen with no explanation.

#### Changes needed

**`gitService.ts` — `makeRequest()`:** Detect 401 specifically and throw a typed error (e.g. `GitAuthError`) distinct from other API errors. This allows callers to handle auth failures differently from network errors or rate limits.

**App-level 401 modal (in `AppShell.tsx`):** A global event-driven modal that any code path can trigger. When a `GitAuthError` is caught anywhere in the app:

1. Dispatch a custom event (e.g. `dagnet:gitAuthExpired`)
2. AppShell listens for this event and shows a **dismissable modal**:

   > **GitHub credentials expired**
   >
   > Your saved credentials are no longer valid. Connect your GitHub account to continue syncing.
   >
   > **[Connect GitHub]** &nbsp; **[Dismiss]**

3. **Connect GitHub** triggers `startOAuthFlow()` for the currently selected repo
4. **Dismiss** closes the modal, then shows a **toast**: "You can reconnect any time via the 'connect 🔗' chip in the menu bar."
5. The modal reappears on the **next 401** (not suppressed after dismiss)

This centralises the 401 UX in one place rather than adding handling to every caller (usePullAll, commit flow, NavigatorContext, etc.). Any code that catches a `GitAuthError` just dispatches the event.

**Callers (`usePullAll.ts`, `repositoryOperationsService.ts`, `NavigatorContext.tsx`):** Catch `GitAuthError`, dispatch `dagnet:gitAuthExpired`, and suppress the raw error message (the modal handles the user communication).

**Tests:** Integration tests that verify `GitAuthError` is thrown on 401. Test that the event dispatch mechanism works (event fired → modal state set). Test against real fake-indexeddb to verify the app doesn't corrupt state on auth failure.

#### Deploy and test

- Deploy to production
- Temporarily test by using a revoked/invalid token in a test browser's IDB credentials
- Verify each scenario shows a clear nudge to connect, not a raw error or blank screen
- Verify users who are already OAuth-connected are unaffected

---

### B2. PAT swap and revocation (no code deploys)

**Prerequisite:** B1 is deployed and tested. All 401 paths show clear connect nudges.

#### B2a. Create and verify a read-only PAT

Create a fine-grained PAT on the repo owner's GitHub account, scoped to the target repo, **Contents: Read** only.

**Verify with `curl` against every GitHub API endpoint DagNet uses for read operations:**

```
# Tree listing (used by getRepositoryTree)
curl -H "Authorization: token <ro-pat>" https://api.github.com/repos/<owner>/<repo>/git/trees/main?recursive=1

# Blob content (used by getBlobContent)
curl -H "Authorization: token <ro-pat>" https://api.github.com/repos/<owner>/<repo>/git/blobs/<sha>

# Ref lookup (used by getRemoteHeadSha)
curl -H "Authorization: token <ro-pat>" https://api.github.com/repos/<owner>/<repo>/git/ref/heads/main

# Push (must fail — confirm 403/404)
curl -X POST -H "Authorization: token <ro-pat>" https://api.github.com/repos/<owner>/<repo>/git/commits -d '{}'
```

If any read endpoint fails, fix the PAT scope before proceeding.

#### B2b. Update Vercel env vars and redeploy

- Update `VITE_INIT_CREDENTIALS_JSON` in Vercel production env vars: replace the current full-access PAT with the new read-only PAT
- Redeploy so new users (and anyone who re-inits) get the read-only token
- **Wait for the deploy to be live before proceeding to B2c**

#### B2c. Revoke the old full-access PAT

**CRITICAL: B2b must be live before this step.** If the old PAT is revoked while the env still contains it, any user who clears their browser and re-inits will get a revoked token and be unable to clone. The ordering is:

1. B2b live (new read-only PAT in env) → new inits work
2. B2c (revoke old PAT) → old tokens in existing users' IDB stop working → B1 nudge kicks in

With this ordering, the user experience is:

- **Already connected via OAuth:** unaffected (they use their own `ghu_` token)
- **Returning user, never connected (workspace cached in IDB):** can still browse locally from cache. Next pull/push hits 401 → B1 nudge → clicks "connect 🔗" → carries on.
- **Fresh user or re-init:** gets the read-only PAT from env → clone works → can browse → "connect 🔗" for write access

Steps:
- Go to `github.com` → Settings → Developer settings → Personal access tokens
- Find and **revoke** the old full-access PAT

#### Rollback plan

- If 401 handling (B1) isn't working as expected: re-create a full-access PAT, update env vars, redeploy. Users re-init from secret to pick up the new token.
- The 401 handling code is harmless even if the rollback PAT is valid — it only triggers on actual 401s.

---

## Deploy count summary

| Step | Deploy target | What's validated |
|---|---|---|
| A0 | None | GitHub App + env vars verified via `curl`, no code |
| A1 | Preview (1 deploy) | Serverless callback + bare round trip |
| A2 | Preview (1 deploy) | Full wiring: OAuth → token into credentials → git ops |
| A3 | Production (1 deploy) | Same as A2, on real domain, behind FF |
| A4 | None | Deployment guide written, README updated |
| A5 | Production (1 deploy) | Remove FF — OAuth live for all users |
| B1 | Production (1 deploy) | 401 handling + connect nudge |
| B2 | None (env var + PAT revoke) | Swap to read-only PAT, revoke old PAT |

**Total: 4 deploys to preview, 3 deploys to production.** Each deploy should work first time because the config and wiring are pre-verified at each stage.

## Environment Variables Summary

| Variable | Where | When it changes |
|---|---|---|
| `VITE_INIT_CREDENTIALS_JSON` | Vercel env, browser build-time | Unchanged throughout Macro A. Swapped to read-only PAT + `authModel` marker in B2 |
| `VITE_INIT_CREDENTIALS_SECRET` | Vercel env, browser build-time | Unchanged throughout |
| `VITE_GITHUB_OAUTH_CLIENT_ID` | Vercel env, browser build-time | Set in A0c, never changes |
| `GITHUB_OAUTH_CLIENT_SECRET` | Vercel env, serverless only | Set in A0c, never changes |

## Files Changed Summary

### Macro A — new files
- `graph-editor/api/auth-callback.ts` — serverless OAuth callback (done in A1)
- `graph-editor/api/auth-status.ts` — env var health-check endpoint (done in A1)
- `graph-editor/src/services/githubOAuthService.ts` — client-side OAuth trigger (`startOAuthFlow()`)

### Macro A — modified files
- `graph-editor/src/components/MenuBar/RepositoryMenu.tsx` — "read-only 🔗" / "@username" clickable chip
- `graph-editor/src/AppShell.tsx` — OAuth return handler (write token into credentials file, clean URL, reload creds), post-init toast

### Macro A — unchanged
- `graph-editor/src/lib/credentials.ts` — no changes needed, token is in the credentials file as before
- `graph-editor/src/db/appDatabase.ts` — no changes needed, no new tables or schema

### Macro B — new files
- `graph-editor/src/components/MigrationModal.tsx` — blocking migration modal

### Macro B — modified files
- `graph-editor/src/lib/credentials.ts` — migration detection (`authModel` marker check)
- `graph-editor/src/AppShell.tsx` — migration modal mount

### Unchanged throughout
- `graph-editor/src/services/gitService.ts` — already accepts a token via Octokit
- `graph-editor/src/services/repositoryOperationsService.ts` — gets credentials from `credentialsManager` as before
- `graph-editor/src/services/workspaceService.ts` — unchanged
- All git operation logic — unchanged

## Deployment Guide

A key output of this work is a **deployment guide** — a standalone document (referenced from the project README) that any deployer of DagNet can follow to set up GitHub authentication for their own instance.

The guide must cover:
- Registering a GitHub App on the deployer's GitHub account (with exact field-by-field instructions)
- Setting Vercel env vars (`VITE_GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`)
- Creating a read-only PAT for the base credentials
- Updating `VITE_INIT_CREDENTIALS_JSON` with the read-only PAT and `authModel` marker
- Adding collaborators to the target repo
- Verifying the setup works (the `/api/auth-status` endpoint and manual OAuth round trip)

This guide is written as a step within Macro A (after the code is working) and lives at `graph-editor/public/docs/deployment-github-auth.md` (accessible in-app and on GitHub). The README references it.

**Why each deployment needs its own GitHub App:** GitHub Apps require callback URLs to be registered as exact paths. Since each DagNet deployment runs on a different domain, each needs its own GitHub App with its own callback URL(s). The client ID and secret are deployment-specific configuration, passed via Vercel env vars — they never appear in the codebase.

## Open Questions

1. **Token delivery from callback:** Redirect with `?github_token=...` in the URL is simplest but briefly exposes the token in browser history. Alternative: the callback serves a small HTML page that uses `window.opener.postMessage()` to send the token to the parent window, then closes itself. The `postMessage` approach is cleaner but slightly more code.

2. **Disconnect flow UX:** Clicking "@username" chip opens a popover with "Disconnect GitHub" — or should it be inside the Repository menu dropdown?
