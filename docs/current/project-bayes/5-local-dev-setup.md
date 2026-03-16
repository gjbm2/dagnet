# Bayes: Local Development Setup

**Date**: 16-Mar-26
**Purpose**: How to run and test the Bayes pipeline locally — both fully local
and with Modal remote compute.

---

## Prerequisites

- Node 22+ (via nvm, see `.nvmrc`)
- Python 3.12+ with the repo venv activated (`graph-editor/venv`)
- `cloudflared` CLI (for Modal mode tunnel)

### Installing cloudflared

```bash
# macOS
brew install cloudflare/cloudflare/cloudflared

# Linux (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# Or via Go
go install github.com/cloudflare/cloudflared/cmd/cloudflared@latest
```

No Cloudflare account needed — quick tunnels are free and anonymous.

### Installing Modal CLI (for deployments only)

```bash
pip install modal
modal token set
```

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Browser (localhost:5173)                             │
│  ┌─────────────────┐                                 │
│  │ DevBayesTrigger  │  [L] local  [M] Modal          │
│  │ useBayesTrigger  │                                 │
│  └────────┬────────┘                                 │
│           │ submit + poll                             │
└───────────┼──────────────────────────────────────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼ (local)       ▼ (Modal)
┌────────────┐  ┌──────────────┐
│ Python :9000│  │ Modal (remote)│
│ /api/bayes/ │  │ /submit       │
│ submit      │  │ /status       │
│ status      │  └───────┬──────┘
└──────┬─────┘          │
       │                │ webhook POST
       │                ▼
       │         ┌──────────────┐
       │         │ cloudflared   │
       │         │ tunnel        │
       │         └──────┬───────┘
       │                │
       ▼                ▼
┌──────────────────────────────────────┐
│ Vite :5173                            │
│ /api/bayes-webhook                    │
│ (decrypt token → read YAML → commit) │
└──────────────────────────────────────┘
            │
            ▼
      GitHub API
 (read graph, commit _bayes)
```

---

## Two modes

### Local mode (default)

Everything runs on your machine. No tunnel needed.

| Component | Where |
|---|---|
| FE trigger | Browser, localhost:5173 |
| Compute (fit_graph) | Python dev server, localhost:9000 |
| Webhook handler | Vite middleware, localhost:5173 |
| Submit URL | `http://localhost:9000/api/bayes/submit` |
| Status URL | `http://localhost:9000/api/bayes/status` |
| Webhook URL | `http://localhost:5173/api/bayes-webhook` |

**Use for**: iterating on inference logic, webhook handler code, FE integration.
Full logs in both terminals.

### Modal mode

Real Modal compute, but webhook still runs locally (via tunnel) so you get full
logs.

| Component | Where |
|---|---|
| FE trigger | Browser, localhost:5173 |
| Compute (fit_graph) | Modal (remote) |
| Webhook handler | Vite middleware, localhost:5173 (via tunnel) |
| Submit URL | Modal endpoint (from config) |
| Status URL | Modal endpoint (from config) |
| Webhook URL | `https://xxx.trycloudflare.com/api/bayes-webhook` |

**Use for**: testing against real Modal (cold starts, image builds, memory
limits, GPU), testing with compute-heavy workloads that would blow out your
local machine.

The toggle starts/stops the cloudflared tunnel automatically.

---

## Running locally

### 1. Start dev servers

```bash
./dev-start.sh
```

This starts both Vite (:5173) and Python (:9000) in tmux panes.

### 2. Ensure .env.local has Bayes config

```
BAYES_MODAL_SUBMIT_URL=https://...modal.run
BAYES_MODAL_STATUS_URL=https://...modal.run
BAYES_WEBHOOK_SECRET=...
BAYES_WEBHOOK_URL=https://dagnet-nine.vercel.app/api/bayes-webhook
DB_CONNECTION=postgresql://...
```

These are used by the `/api/bayes/config` endpoint and by Modal mode.
Local mode ignores the Modal URLs and uses localhost instead.

### 3. Use the dev toggle

In the menu bar (dev mode only), next to the console mirror controls:

- **[L] Bayes** — local mode (default). Click Bayes to trigger.
- **[M] Bayes** — Modal mode. Click the L/M toggle to switch. Tunnel starts
  automatically.

Logs appear in:
- **Python terminal** — compute logs (Neon connection, posteriors built, webhook POST)
- **Vite terminal** — webhook logs (token decrypted, GitHub read/commit)
- **Browser session log** — full roundtrip timeline

---

## Python dependency tiers

Three tiers of Python dependencies serve different environments. Getting this
wrong bloats the Vercel bundle (50 MB limit) or breaks local dev.

| Tier | Where it runs | Packages | File |
|---|---|---|---|
| **Production** | Vercel serverless | networkx, pydantic, psycopg2-binary, requests, pyyaml | `requirements.txt` (core section) |
| **Dev server** | Local Python :9000 | Above + fastapi, uvicorn, python-dotenv, pytest | `requirements.txt` (dev section) |
| **Bayes simulation** | Local Python :9000 (`bayes_worker.py`) | Above + numpy, scipy, pymc, arviz | `requirements.txt` (optional section — uncomment when needed) |

**Key rule**: the Bayes simulation tier (numpy, scipy, pymc, arviz) must **never**
be deployed to Vercel. These packages exist only for local simulation of Modal's
`science_image`. In production, Modal's own container image installs them
independently (see `bayes/app.py` `science_image` definition).

Currently `bayes_worker.py` builds placeholder posteriors and does not need the
scientific stack. When real inference is added, uncomment the optional section in
`requirements.txt` for local dev, but do **not** move those packages into the
core section.

If the split becomes unwieldy, create a separate `requirements-bayes.txt` that
extends the base file.

---

## Deployment

### Vercel (automatic)

Push to `main` → Vercel deploys automatically. Includes:
- `/api/bayes-webhook` (serverless function)
- `/api/bayes-config` (serverless function)
- FE bundle

### Modal (manual)

```bash
./deploy-modal.sh
```

Deploy when `bayes/` code changes. Independent of Vercel releases.

**Note**: after deploy, warm Modal containers may run old code for a few minutes
until they recycle. If you see stale behaviour, wait or redeploy.

### When to deploy what

| Changed | Deploy |
|---|---|
| `graph-editor/src/`, `graph-editor/api/` | Push to main (Vercel auto) |
| `bayes/app.py` | `./deploy-modal.sh` |
| Both | Push to main + `./deploy-modal.sh` |

---

## Troubleshooting

### "BAYES_WEBHOOK_SECRET not configured"
Add `BAYES_WEBHOOK_SECRET=...` to `graph-editor/.env.local`. Get value from
Vercel env vars (`vercel env pull`).

### Local webhook returns 502 from GitHub
Check git credentials — the callback token contains the user's GitHub token.
Ensure you're logged in with credentials that have write access to the target
repo/branch.

### Modal mode: tunnel fails to start
Ensure `cloudflared` is installed and on PATH. The tunnel requires outbound
HTTPS — check firewall/proxy settings.

### Modal warm container runs old code
Wait 2–3 minutes for containers to recycle, or run `./deploy-modal.sh` again.

### Python server import errors
Ensure the venv is activated and `psycopg2-binary` + `requests` are installed:
```bash
source graph-editor/venv/bin/activate
pip install psycopg2-binary requests
```
