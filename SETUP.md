# DagNet - Quick Setup Guide

## New Machine Setup (5 minutes)

### 1. Clone & Configure

```bash
git clone <repo-url>
cd dagnet/graph-editor
cp .env.example .env
nano .env  # or vim, code, etc.
```

**Edit these in `.env`:**
```bash
VITE_GITHUB_TOKEN=ghp_your_token_here
VITE_GIT_REPO_OWNER=your-username
VITE_GIT_REPO_NAME=your-repo
```

### 2. Start Development

```bash
cd ..
./dev-start.sh
```

That's it! 🎉

**Servers:**
- Frontend: http://localhost:5173
- Python API: http://localhost:9000
- API Docs: http://localhost:9000/docs

---

## Port Conflicts?

Edit `graph-editor/.env`:

```bash
VITE_PORT=5174              # Change frontend port
VITE_PYTHON_API_PORT=9001   # Change Python port
VITE_PYTHON_API_URL=http://localhost:9001  # Match Python port
```

Then restart: `./dev-start.sh`

---

## Frontend-Only Development?

Don't want to run Python backend:

```bash
# In graph-editor/.env
VITE_USE_MOCK_COMPUTE=true
```

All Python API calls will return mock data.

---

## Troubleshooting

**Python server won't start:**
```bash
python3 --version  # Check Python 3.9+
source venv/bin/activate
pip install fastapi uvicorn networkx pydantic pytest
```

**Port already in use:**
```bash
lsof -i :5173  # or :9000
kill -9 <PID>
# Or just: ./dev-stop.sh
```

**Fresh install:**
```bash
./dev-start.sh --clean
```

---

## Files

- ✅ `.env.example` - Committed to git (template)
- ❌ `.env` - Gitignored (your secrets)
- ✅ `dev-start.sh` - Start both servers
- ✅ `dev-stop.sh` - Stop everything

---

## Test Coverage

```bash
# All tests
npm test                    # TypeScript (199 tests)
pytest tests/ -v            # Python (6 tests)

# Note: 11 TypeScript tests require Python server running
# They auto-skip if server is not available
```
