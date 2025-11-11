# DagNet - Directed Acyclic Graph Network Editor

A web-based visual editor for creating and analyzing directed acyclic graphs (DAGs) with support for conditional probabilities, file-backed parameters, and advanced graph analytics.

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
├── graph-editor/             # Frontend React/TypeScript app (Vercel deployment root)
│   ├── lib/                  # Python graph computation libraries
│   ├── tests/                # Python tests
│   ├── api/                  # Serverless functions (TS + Python)
│   ├── dev-server.py         # Local Python dev server
│   ├── requirements.txt      # Python dependencies
│   ├── pytest.ini           # Pytest configuration
│   └── venv/                 # Python virtual environment (local dev)
├── PROJECT_CONNECT/          # Technical documentation
│   ├── README.md            # Project roadmap
│   └── CURRENT/             # Active work documentation
├── dev-start.sh             # Quick-start script
└── dev-stop.sh              # Stop all dev servers
```

## Features

- **Visual Graph Editor**: Drag-and-drop nodes and edges
- **Conditional Probabilities**: Define probabilities based on graph state
- **File-Backed Parameters**: Link parameters to external data sources
- **Data Connections & Adapters**: Connect to Amplitude, Google Sheets, PostgreSQL, and more via DAS (Data Adapter Service)
- **Time-Series Data**: Daily breakdowns with incremental fetching and window aggregation
- **Query DSL**: Powerful query language for graph traversal
- **What-If Analysis**: Simulate different scenarios
- **Graph Analytics**: MSMDC, mutations, pruning (Python/NetworkX)
- **Case Variants**: A/B testing and multivariate scenarios
- **Batch Operations**: Bulk data fetching and updates across multiple parameters

## Documentation

### User Documentation
- [User Guide](graph-editor/public/docs/user-guide.md) - Getting started and core concepts
- [Data Connections & Adapters](graph-editor/public/docs/data-connections.md) - Connect to external data sources
- [Query Expressions](graph-editor/public/docs/query-expressions.md) - Query DSL reference
- [What-If Analysis](graph-editor/public/docs/what-ifs-with-conditionals.md) - Scenario modeling
- [API Reference](graph-editor/public/docs/api-reference.md) - Programmatic access

### Technical Documentation
See [PROJECT_CONNECT/README.md](PROJECT_CONNECT/README.md) for:
- Current project status and roadmap
- Technical debt tracking
- Architecture decisions
- Phase-by-phase implementation plan

### Key Technical Docs
- [Python Graph Compute Architecture](PROJECT_CONNECT/CURRENT/PYTHON_GRAPH_COMPUTE_ARCHITECTURE.md)
- [Conditional Probability & Graph Updates](PROJECT_CONNECT/CURRENT/CONDITIONAL_P_AND_GRAPH_UPDATES.md)
- [Schema Changes](PROJECT_CONNECT/CURRENT/SCHEMA_CHANGES_AND_TODO.md)
- [Data Model Hierarchy](PROJECT_CONNECT/CURRENT/DATA_MODEL_HIERARCHY.md)

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

1. Check [PROJECT_CONNECT/README.md](PROJECT_CONNECT/README.md) for current priorities
2. Review technical debt in [CURRENT/](PROJECT_CONNECT/CURRENT/) docs
3. Write tests for new features
4. Ensure both frontend and Python tests pass

## License

MIT

