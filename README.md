# DagNet - Directed Acyclic Graph Network Editor

**Version 1.0.0-alpha** | [Changelog](graph-editor/public/docs/CHANGELOG.md) | [About](graph-editor/public/docs/about.md)

A web-based visual editor for creating and analyzing directed acyclic graphs (DAGs) with support for conditional probabilities, file-backed parameters, cohort-based analytics, and latency-aware forecasting.

> 📖 **New to DagNet?** See [About DagNet](graph-editor/public/docs/about.md) for an overview of capabilities and the [User Guide](graph-editor/public/docs/user-guide.md) to get started. Full documentation is in [`graph-editor/public/docs/`](graph-editor/public/docs/).

## Quick Start

### First Time Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd dagnet
   ```

2. **Configure environment variables**
   ```bash
   cd graph-editor
   cp .env.example .env.local  # or .env
   # Edit .env.local with your GitHub token and other settings
   ```
   
   Note: Use `.env.local` for local development with secrets (not committed to git), or `.env` for shared defaults.

   **Required variables:**
   - `VITE_GITHUB_TOKEN` - GitHub personal access token (for file operations)
   - `VITE_GIT_REPO_OWNER` - Your GitHub username
   - `VITE_GIT_REPO_NAME` - Your repository name

   **Optional variables (defaults work for most setups):**
   - `VITE_PORT=5173` - Frontend dev server port
   - `VITE_PYTHON_API_PORT=9000` - Python backend port
   - `VITE_PYTHON_API_URL=http://localhost:9000` - Python backend URL
   - `VITE_USE_MOCK_COMPUTE=false` - Set to `true` for frontend-only development

3. **Start development servers**
   ```bash
   cd ..  # Back to root
   ./dev-start.sh
   ```

   This will:
   - Install all dependencies (npm + Python)
   - Start frontend on port specified in `.env` (default: 5173)
   - Start Python API on port specified in `.env` (default: 9000)
   - Open split tmux panes for both

### Development (Local)

```bash
# One-command dev server (frontend + Python API in split panes):
./dev-start.sh

# With clean install (clears caches, reinstalls everything):
./dev-start.sh --clean

# Stop servers:
./dev-stop.sh
```

**Access:**
- Frontend: http://localhost:5173 (or your `VITE_PORT`)
- Python API: http://localhost:9000 (or your `PYTHON_API_PORT`)
- API Docs: http://localhost:9000/docs

**Requirements:**
- Node.js 18+
- Python 3.9+
- tmux (auto-installed by script if missing)
- GitHub personal access token (create at https://github.com/settings/tokens)

### Manual Setup

```bash
# Frontend
cd graph-editor
npm install
npm run dev

# Python API (separate terminal)
cd graph-editor
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python dev-server.py
```

## Project Structure

```
dagnet/
├── graph-editor/             # Frontend React/TypeScript app (**Vercel deployment root**)
│   ├── src/                  # React/TypeScript source code
│   ├── public/               # Static assets and public documentation
│   │   └── docs/            # **PUBLIC USER DOCUMENTATION** (user-facing guides)
│   ├── api/                  # Serverless functions (TS + Python)
│   ├── lib/                  # **ALL PYTHON LIBRARIES** (graph computation, MSMDC, queries)
│   │   ├── algorithms/       # MSMDC algorithms (inclusion-exclusion, graph analysis)
│   │   ├── msmdc.py          # MSMDC query generation
│   │   ├── query_dsl.py      # Query DSL parser
│   │   ├── graph_types.py    # Graph data models
│   │   ├── graph_select.py   # Graph topology filtering
│   │   └── stats_enhancement.py  # Statistical enhancements
│   ├── tests/                # Python tests
│   ├── docs/                 # Component-specific technical documentation
│   ├── dev-server.py         # Local Python dev server
│   ├── requirements.txt      # Python dependencies
│   ├── pytest.ini           # Pytest configuration
│   └── venv/                 # Python virtual environment (local dev)
├── docs/                     # **TECHNICAL DOCUMENTATION** (developer/architecture docs)
│   ├── current/              # Current technical documentation and specs
│   │   └── project-contexts/ # Project context and status documents
│   └── archive/              # Historical documentation and completed work
│       └── project-perf/     # Performance testing and benchmarks (moved from /perf)
├── param-registry/           # Dev testing: app accesses git files here; create sample files for testing
├── apps-script/              # Google Apps Script integrations
├── dev-start.sh             # Quick-start script (starts frontend + backend)
├── dev-stop.sh              # Stop all dev servers
└── dev-restart.sh           # Restart development servers
```

## Features

### 🕐 Project LAG: Temporal Probability (1.0)

The 1.0 release introduces **Latency-Aware Graphs** — a shift from static snapshots to time-indexed flow models.

| Capability | Description |
|------------|-------------|
| **Cohort Windows** | Analyse users by *entry date* with `cohort(1-Dec-25:7-Dec-25)` DSL |
| **Daily Time-Series** | Full `n_daily`, `k_daily` arrays stored per parameter file |
| **On-the-fly Aggregation** | Select any date range; evidence recalculates instantly |
| **Latency Tracking** | Model time-to-convert with `maturity_days` configuration |
| **Evidence vs Forecast** | Distinguish observed ($p_{evidence}$) from projected ($p_{\infty}$) |

### Visual Graph Editor
- **Drag-and-Drop Canvas**: Create nodes, connect edges, visualise probability flow
- **Copy & Paste / Drag & Drop**: Rapid graph construction from registry files
- **Multiple Views**: Graph canvas, raw JSON/YAML, schema-driven forms
- **Latency Beads**: Visual indicators showing median lag and cohort completeness

### Probability & Analytics
- **Conditional Probabilities**: `visited()`, `exclude()` modifiers per edge
- **What-If Analysis**: Change any parameter, see downstream impact instantly
- **Scenarios**: Save, compare, and overlay parameter configurations
- **MSMDC Engine**: Multi-path probability calculations (Python/NetworkX)
- **Case Variants**: A/B testing with weighted variant splits

### Data Connections
- **DAS Adapters**: Amplitude, Google Sheets, PostgreSQL, and custom HTTP sources
- **Contexts**: Segment by channel, device, browser with MECE partition handling
- **Incremental Fetch**: Only retrieve missing days when expanding windows
- **Query DSL**: `from().to().visited().context().cohort()` chaining

## Documentation

### 📚 Public User Documentation

**Location:** [`graph-editor/public/docs/`](graph-editor/public/docs/)

User-facing documentation accessible both in the app and on GitHub:

- **[About DagNet](graph-editor/public/docs/about.md)** - Project overview, capabilities, and independent assessment
- [User Guide](graph-editor/public/docs/user-guide.md) - Getting started and core concepts
- [Contexts](graph-editor/public/docs/contexts.md) - Data segmentation by channel, device, browser, etc.
- [Data Connections & Adapters](graph-editor/public/docs/data-connections.md) - Connect to external data sources
- [Query Expressions](graph-editor/public/docs/query-expressions.md) - Query DSL reference
- [What-If Analysis](graph-editor/public/docs/what-ifs-with-conditionals.md) - Scenario modeling
- [Scenarios](graph-editor/public/docs/scenarios.md) - Parameter overlays and A/B testing
- [API Reference](graph-editor/public/docs/api-reference.md) - Programmatic access
- [Keyboard Shortcuts](graph-editor/public/docs/keyboard-shortcuts.md) - Productivity tips
- [LAG Statistics Reference](graph-editor/public/docs/lag-statistics-reference.md) - Latency-aware graph statistics (canonical)
- [CHANGELOG](graph-editor/public/docs/CHANGELOG.md) - Release history

### 🔧 Technical Documentation

**Location:** [`docs/`](docs/)

Developer and architecture documentation:

#### Current Documentation (`docs/current/`)
Active technical specs, architecture decisions, and project contexts:
- Check `docs/current/project-contexts/` for current project status and work plans

#### Component-Specific Docs (`graph-editor/docs/`)
- [Amplitude Credentials Setup](graph-editor/docs/AMPLITUDE_CREDENTIALS_SETUP.md)
- [DAS CORS Explanation](graph-editor/docs/DAS_CORS_EXPLANATION.md)
- [DAS DSL Excludes and Subtraction](graph-editor/docs/DAS_DSL_EXCLUDES_AND_SUBTRACTION.md)
- [Proxy Local vs Production](graph-editor/docs/PROXY_LOCAL_VS_PRODUCTION.md)

#### Testing Documentation (`graph-editor/`)
- [Integration Testing Guide](graph-editor/INTEGRATION_TESTING_GUIDE.md)
- [Testing Strategy](graph-editor/TESTING_STRATEGY.md)
- [Test Quick Start](graph-editor/TEST_QUICK_START.md)

#### Archive (`docs/archive/`)
Historical documentation and completed work - useful for understanding design decisions and past implementations

## Tech Stack

**Frontend:**
- React 18 + TypeScript
- Vite
- ReactFlow (graph visualization)
- Monaco Editor (query DSL)
- Zustand (state management)

**Backend:**
- Python 3.9+ (graph computation)
- NetworkX (graph algorithms)
- FastAPI (local dev server)
- Vercel Serverless Functions (production)

**Deployment:**
- Vercel (edge network + serverless)
- Region co-location for minimal latency

## Development Workflow

### Hot Reload
Both servers support hot reload:
- **Frontend**: Vite HMR (instant updates)
- **Python**: Uvicorn auto-reload (restarts on file change)

## Local development

Using /dev-server.py:

Local Development:
┌─────────────────┐         ┌──────────────────┐
│  Vite Frontend  │────────▶│  dev-server.py   │
│  :5173          │  HTTP   │  :9000           │
│  (TypeScript)   │◀────────│  (Python/FastAPI)│
└─────────────────┘         └──────────────────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │ lib/*.py    │
                              │ (NetworkX,  │
                              │  algorithms)│
                              │ (in graph-  │
                              │  editor/)   │
                              └─────────────┘

Production (Vercel):
┌─────────────────┐         ┌──────────────────┐
│  Static Assets  │────────▶│  Serverless Fns  │
│  CDN            │  HTTP   │  /api/*.py       │
│  (React build)  │◀────────│  (Python)        │
└─────────────────┘         └──────────────────┘

### Testing

```bash
# Frontend tests
cd graph-editor
npm test

# Python tests
cd graph-editor
source venv/bin/activate
pytest tests/ -v
pytest tests/ --cov=lib --cov-report=html
```

### Cleaning/Resetting

```bash
# Full clean and restart
./dev-start.sh --clean

# Manual cleanup
cd graph-editor
npm cache clean --force
rm -rf node_modules package-lock.json
rm -rf venv
find . -type d -name "__pycache__" -exec rm -rf {} +
cd ..
```

### Troubleshooting

#### Port Already in Use

If you get "port already in use" errors:

1. **Change ports in your env file:**
   ```bash
   # Edit graph-editor/.env.local (or .env)
   VITE_PORT=5174              # or any free port
   VITE_PYTHON_API_PORT=9001   # or any free port
   VITE_PYTHON_API_URL=http://localhost:9001  # match Python port
   ```

2. **Find what's using the port:**
   ```bash
   # Linux/Mac
   lsof -i :5173
   lsof -i :9000
   
   # Kill process if needed
   kill -9 <PID>
   ```

3. **Or use dev-stop.sh to clean up:**
   ```bash
   ./dev-stop.sh
   ```

#### Python Server Not Starting

- Ensure Python 3.9+ is installed: `python3 --version`
- Check virtual environment: `cd graph-editor && source venv/bin/activate`
- Manually install dependencies: `cd graph-editor && pip install -r requirements.txt`

#### Frontend Tests Skipping

Some tests require Python backend running:
- 11 integration tests will skip if Python server is not running
- This is normal for frontend-only development
- To run all tests: start Python server first with `cd graph-editor && python dev-server.py`

#### Mock Mode for Frontend-Only Development

If you don't want to run the Python backend:

```bash
# Set in graph-editor/.env.local (or .env)
VITE_USE_MOCK_COMPUTE=true
```

This returns mock data for all Python API calls.

## Contributing

1. Check `docs/current/project-contexts/` for current project status and priorities
2. Review technical documentation in `docs/current/` and `docs/archive/`
3. Write tests for new features
4. Ensure both frontend and Python tests pass
5. Update relevant documentation in `graph-editor/public/docs/` for user-facing changes

## License

MIT

