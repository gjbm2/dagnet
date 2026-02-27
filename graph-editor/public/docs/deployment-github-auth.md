# GitHub Authentication Setup

This guide walks you through setting up per-user GitHub authentication for your DagNet deployment. After completing these steps, users can connect their own GitHub account for write access (push, commit), while everyone else gets read-only access via a shared token.

## Prerequisites

- A deployed DagNet instance on Vercel
- A GitHub account that owns (or has admin access to) the graph repository
- Access to your Vercel project's environment variables

## Overview

Each DagNet deployment needs its own GitHub App. The app's client ID and secret are passed to DagNet via Vercel environment variables. Users authenticate by clicking a "connect" chip in the menu bar, which redirects them to GitHub and back.

## Step 1: Register a GitHub App

1. Go to **github.com → Settings → Developer settings → GitHub Apps → New GitHub App**

2. Fill in the fields:

   **Basic info:**
   - **GitHub App name:** your choice — must be globally unique on GitHub (e.g. `DagNet - My Org`). Visible to users on the authorisation prompt.
   - **Description:** a short description identifying your DagNet instance.
   - **Homepage URL:** your Vercel production URL (e.g. `https://my-dagnet.vercel.app`)

   **Identifying and authorising users:**
   - **Callback URL:** `https://<your-vercel-domain>/api/auth-callback`
   - Add additional callback URLs for any preview/staging domains you use
   - **Expire user authorisation tokens:** **uncheck** — tokens will not expire, keeping things simple
   - **Request user authorization (OAuth) during installation:** **unchecked**
   - **Enable Device Flow:** **unchecked**

   **Post installation:**
   - **Setup URL:** leave blank
   - **Redirect on update:** **unchecked**

   **Webhook:**
   - **Active:** **uncheck** — DagNet does not use webhook events

   **Permissions:**
   - **Repository permissions → Contents:** set to **Read and write**
   - Leave all other repository, organisation, and account permissions at **No access**

   **Subscribe to events:**
   - Leave all unchecked

   **Where can this GitHub App be installed?**
   - Select **Any GitHub account** — this is required so that collaborators (who have their own GitHub accounts) can authorise the app

3. Click **Create GitHub App**

4. On the app page, note the **Client ID** (shown immediately)

5. Click **Generate a new client secret** and save the secret (shown once)

6. Under **Optional features**, find **User-to-server token expiration** and click **Opt-out** if not already opted out

## Step 2: Set Vercel environment variables

In your Vercel project dashboard, go to **Settings → Environment Variables** and add:

| Variable | Value | Scope |
|---|---|---|
| `VITE_GITHUB_OAUTH_CLIENT_ID` | Your GitHub App client ID | All Environments |
| `GITHUB_OAUTH_CLIENT_SECRET` | Your GitHub App client secret (mark as **Sensitive**) | All Environments |

These are in addition to your existing `VITE_INIT_CREDENTIALS_JSON` and `VITE_INIT_CREDENTIALS_SECRET` variables.

## Step 3: Verify the setup

After deploying (or on next deploy), verify:

1. Open `https://<your-domain>/api/auth-status` — should return:
   ```json
   {"VITE_GITHUB_OAUTH_CLIENT_ID":"set","GITHUB_OAUTH_CLIENT_SECRET":"set"}
   ```

2. Open your DagNet instance with `?oauth` appended to the URL (e.g. `https://<your-domain>/?oauth`)

3. You should see a **"connect 🔗"** chip in the menu bar

4. Click it, authorise on GitHub, and verify you're redirected back with a toast confirming your GitHub username

## Step 4: Add collaborators

Users who connect their GitHub account get write access only if they are **collaborators** on the target repository. To add collaborators:

1. Go to the graph repository on GitHub
2. **Settings → Collaborators → Add people**
3. Search for the user's GitHub username and invite them

Users who are not collaborators can still connect their GitHub account, but write operations (push, commit) will fail with a permission error.

## How it works for users

1. User opens DagNet and initialises with the shared secret (first time only)
2. They see a **"connect 🔗"** chip in the menu bar
3. They click it → redirected to GitHub → authorise → redirected back
4. Their personal GitHub token replaces the shared token for the current repository
5. Commits are now attributed to their GitHub identity
6. If they need to disconnect, they re-initialise from the shared secret

## Troubleshooting

**"redirect_uri is not associated with this application"**
- The callback URL in the GitHub App settings doesn't match your Vercel domain. Check that `https://<your-domain>/api/auth-callback` is listed as a callback URL on the GitHub App.

**auth-status returns "not set" for one or both variables**
- Check that the environment variables are set in Vercel for the correct scope (Preview + Production, or All Environments).
- Environment variable changes require a redeploy to take effect.

**User can connect but can't push**
- The user is not a collaborator on the target repository. Add them via GitHub repository settings.

**Chip doesn't appear**
- The OAuth feature flag must be enabled. Either add `?oauth` to the URL, or set `VITE_FEATURE_OAUTH=1` in your Vercel environment variables.
