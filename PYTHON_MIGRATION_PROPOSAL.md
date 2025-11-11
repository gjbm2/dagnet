# Python Project Structure Migration Proposal

## Problem Statement

The current Python project structure places critical files at the project root (`/lib/`, `/requirements.txt`, `/dev-server.py`, `/venv/`), but **Vercel deploys from `/graph-editor/`** and cannot access files outside that directory. This causes:

1. **Production 500 errors**: Vercel Python serverless functions cannot import from `/lib/` because it's outside the deployment scope
2. **Architectural mismatch**: The original architecture assumed Vercel could see the entire repository, which is incorrect
3. **Deployment failures**: `/api/generate-all-parameters` and `/api/stats-enhance` fail in production

## Current State Analysis

### File Locations (Current)

```
/dagnet/
├── lib/                      # ❌ NOT accessible to Vercel
│   ├── __init__.py
│   ├── msmdc.py
│   ├── graph_types.py
│   ├── query_dsl.py
│   ├── graph_select.py
│   └── stats_enhancement.py
├── requirements.txt          # ❌ May not be found by Vercel
├── dev-server.py             # ✅ Works locally (runs from root)
├── venv/                     # ✅ Local dev only (Vercel doesn't use)
├── tests/                    # ✅ Local dev only
│   ├── test_msmdc.py
│   ├── test_query_dsl.py
│   └── fixtures/
├── pytest.ini                # ✅ Local dev only
└── graph-editor/
    ├── api/
    │   ├── generate-all-parameters.py  # ❌ Can't find lib/
    │   └── stats-enhance.py            # ❌ Can't find lib/
    └── ...
```

### Files That Reference Python Paths

#### 1. **dev-server.py** (Root level)
- **Line 14**: `sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))`
- **Lines 157, 206, 287**: `sys.path.insert(0, "lib")`
- **Imports**: `from query_dsl import ...`, `from msmdc import ...`, `from graph_types import ...`
- **Status**: Assumes `lib/` is sibling to `dev-server.py` at root

#### 2. **dev-start.sh** (Root level)
- **Line 50**: `rm -rf venv` (removes venv at root)
- **Line 68-69**: `if [ ! -d "venv" ]; then python3 -m venv venv` (creates venv at root)
- **Line 80**: `source venv/bin/activate` (activates venv at root)
- **Line 85**: `pip install -q fastapi uvicorn[standard] networkx pydantic pytest` (installs deps)
- **Line 130**: `cd $(pwd)` (changes to root directory)
- **Line 134**: `python dev-server.py` (runs dev-server.py from root)
- **Line 143**: `source venv/bin/activate` (activates venv in tmux pane)
- **Status**: Assumes venv, dev-server.py, and requirements.txt are at root

#### 3. **dev-restart.sh** (Root level)
- **Line 31**: `python dev-server.py` (runs from current directory, which is root in tmux)
- **Status**: Assumes dev-server.py is accessible from root

#### 4. **pytest.ini** (Root level)
- **Line 20**: `source = lib` (coverage source assumes lib/ at root)
- **Line 23**: `*/venv/*` (excludes venv from coverage)
- **Status**: Assumes lib/ and venv/ are at root

#### 5. **Test Files** (`tests/` directory)
- **tests/fixtures/graphs.py**: `from lib.graph_types import ...`
- **tests/test_query_dsl.py**: `from lib.query_dsl import ...`
- **tests/test_infrastructure.py**: `from lib.graph_types import ...`
- **tests/test_msmdc.py**: `sys.path.insert(0, "lib")`
- **tests/test_graph_query.py**: `sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'lib'))`
- **Status**: All assume lib/ is at root

#### 6. **Vercel Functions** (`graph-editor/api/`)
- **generate-all-parameters.py**: Tries to find lib/ relative to function location
- **stats-enhance.py**: Tries to find lib/ relative to function location
- **Status**: Currently broken - cannot find lib/ in production

#### 7. **Documentation Files**
- **README.md**: Documents root-level structure
- **PYTHON_SETUP.md**: Documents root-level structure
- **PYTHON_API_ROUTES_ANALYSIS.md**: References root-level paths
- **PROJECT_CONNECT/CURRENT/PYTHON_GRAPH_COMPUTE_ARCHITECTURE.md**: Documents root-level structure

## Proposed Solution

### Target Structure

```
/dagnet/
├── graph-editor/                    # ← Vercel deployment root
│   ├── lib/                        # ✅ MOVED HERE (accessible to Vercel)
│   │   ├── __init__.py
│   │   ├── msmdc.py
│   │   ├── graph_types.py
│   │   ├── query_dsl.py
│   │   ├── graph_select.py
│   │   └── stats_enhancement.py
│   ├── requirements.txt            # ✅ MOVED HERE (Vercel needs this)
│   ├── venv/                       # ✅ MOVED HERE (local dev only)
│   ├── dev-server.py               # ✅ MOVED HERE (local dev)
│   ├── pytest.ini                  # ✅ MOVED HERE (local dev)
│   ├── tests/                      # ✅ MOVED HERE (local dev)
│   │   ├── test_msmdc.py
│   │   ├── test_query_dsl.py
│   │   └── fixtures/
│   ├── api/
│   │   ├── generate-all-parameters.py  # ✅ Can now find lib/
│   │   └── stats-enhance.py            # ✅ Can now find lib/
│   └── ...
└── [other root-level files remain]
```

### Rationale

1. **Vercel Compatibility**: All Python files are now within `/graph-editor/`, which is the Vercel deployment root
2. **Local Dev Continuity**: All Python tooling (dev-server, tests, venv) moves together, maintaining consistency
3. **Single Source of Truth**: One location for all Python code, reducing confusion
4. **Simpler Paths**: Relative imports become simpler (e.g., `from lib.msmdc import ...` works from anywhere in graph-editor/)

## Detailed Migration Steps

### Phase 1: Move Files

**1.1 Move Python Library**
```bash
mv lib/ graph-editor/lib/
```

**1.2 Move Requirements File**
```bash
mv requirements.txt graph-editor/requirements.txt
```

**1.3 Move Dev Server**
```bash
mv dev-server.py graph-editor/dev-server.py
```

**1.4 Move Virtual Environment**
```bash
# Option A: Move existing venv
mv venv/ graph-editor/venv/

# Option B: Recreate venv (recommended for clean state)
rm -rf venv/
cd graph-editor/
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd ..
```

**1.5 Move Tests**
```bash
mv tests/ graph-editor/tests/
```

**1.6 Move Pytest Config**
```bash
mv pytest.ini graph-editor/pytest.ini
```

### Phase 2: Update Path References

**2.1 Update dev-server.py**
- **Line 14**: Change to `sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))`
  - This will now correctly find `graph-editor/lib/` since dev-server.py is in `graph-editor/`
- **Lines 157, 206, 287**: Change `sys.path.insert(0, "lib")` to `sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))`
  - Or remove these if line 14 already handles it

**2.2 Update dev-start.sh**
- **Line 50**: Change `rm -rf venv` to `rm -rf graph-editor/venv`
- **Line 68**: Change `if [ ! -d "venv" ]` to `if [ ! -d "graph-editor/venv" ]`
- **Line 69**: Change `python3 -m venv venv` to `cd graph-editor && python3 -m venv venv && cd ..`
- **Line 80**: Change `source venv/bin/activate` to `source graph-editor/venv/bin/activate`
- **Line 85**: Change `pip install` to `cd graph-editor && pip install -r requirements.txt && cd ..`
- **Line 130**: Change `cd $(pwd)` to `cd $(pwd)/graph-editor`
- **Line 134**: Change `python dev-server.py` to `python dev-server.py` (already in graph-editor/)
- **Line 143**: Change `source venv/bin/activate` to `source venv/bin/activate` (already in graph-editor/)

**2.3 Update dev-restart.sh**
- **Line 31**: Change `python dev-server.py` to `cd graph-editor && python dev-server.py`
  - OR ensure tmux pane is already in graph-editor/ directory

**2.4 Update pytest.ini**
- **Line 20**: Change `source = lib` to `source = lib` (relative to graph-editor/, correct)
- **Line 5**: Change `testpaths = tests` to `testpaths = tests` (relative to graph-editor/, correct)

**2.5 Update Test Files**
- **tests/fixtures/graphs.py**: Change `from lib.graph_types import ...` to `from lib.graph_types import ...` (no change needed - relative import)
- **tests/test_query_dsl.py**: Change `from lib.query_dsl import ...` to `from lib.query_dsl import ...` (no change needed)
- **tests/test_infrastructure.py**: Change `from lib.graph_types import ...` to `from lib.graph_types import ...` (no change needed)
- **tests/test_msmdc.py**: Change `sys.path.insert(0, "lib")` to `sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'lib'))`
- **tests/test_graph_query.py**: Already uses relative path - verify it works

**2.6 Update Vercel Functions**
- **graph-editor/api/generate-all-parameters.py**: 
  - Change path resolution to: `lib_path = os.path.join(os.path.dirname(os.path.dirname(current_dir)), 'lib')`
  - Since function is at `graph-editor/api/`, go up one level to `graph-editor/`, then into `lib/`
- **graph-editor/api/stats-enhance.py**: Same as above

**2.7 Update Documentation**
- **README.md**: Update project structure diagram
- **PYTHON_SETUP.md**: Update paths
- **PYTHON_API_ROUTES_ANALYSIS.md**: Update paths
- **PROJECT_CONNECT/CURRENT/PYTHON_GRAPH_COMPUTE_ARCHITECTURE.md**: Update architecture diagram

### Phase 3: Verification

**3.1 Local Dev Verification**
```bash
# Test dev-start.sh
./dev-start.sh

# Verify:
# - Frontend starts on :5173
# - Python server starts on :9000
# - Can access http://localhost:9000/docs
# - Can make API calls from frontend
```

**3.2 Test Suite Verification**
```bash
cd graph-editor/
source venv/bin/activate
pytest tests/ -v
```

**3.3 Vercel Function Testing**
```bash
cd graph-editor/
vercel dev

# Test endpoints:
curl -X POST http://localhost:3000/api/generate-all-parameters \
  -H "Content-Type: application/json" \
  -d '{"graph": {...}}'

curl -X POST http://localhost:3000/api/stats-enhance \
  -H "Content-Type: application/json" \
  -d '{"raw": {...}, "method": "mcmc"}'
```

**3.4 Production Deployment**
- Deploy to Vercel
- Test production endpoints
- Verify no 500 errors

## Files Requiring Updates

### Must Update (Critical)

1. **dev-server.py** - Path resolution (4 locations)
2. **dev-start.sh** - Venv paths, dev-server path, requirements path (7 locations)
3. **dev-restart.sh** - Dev-server path (1 location)
4. **graph-editor/api/generate-all-parameters.py** - Lib path resolution (1 location)
5. **graph-editor/api/stats-enhance.py** - Lib path resolution (1 location)
6. **tests/test_msmdc.py** - Path resolution (1 location)

### Should Update (Documentation)

7. **README.md** - Project structure diagram
8. **PYTHON_SETUP.md** - Setup instructions
9. **PYTHON_API_ROUTES_ANALYSIS.md** - Path references
10. **PROJECT_CONNECT/CURRENT/PYTHON_GRAPH_COMPUTE_ARCHITECTURE.md** - Architecture diagram

### May Need Updates (Verify)

11. **pytest.ini** - Verify paths work (likely fine as-is)
12. **tests/test_graph_query.py** - Verify path resolution (likely fine as-is)
13. **Other test files** - Verify imports work (likely fine as-is)

## Rollback Plan

If migration causes issues:

1. **Git Reset**: `git reset --hard HEAD` (if changes not committed)
2. **Manual Restore**: Move files back to root:
   ```bash
   mv graph-editor/lib/ lib/
   mv graph-editor/requirements.txt requirements.txt
   mv graph-editor/dev-server.py dev-server.py
   mv graph-editor/venv/ venv/
   mv graph-editor/tests/ tests/
   mv graph-editor/pytest.ini pytest.ini
   ```
3. **Revert Script Changes**: Restore original paths in all scripts

## Testing Checklist

### Pre-Migration
- [ ] Current local dev environment works
- [ ] Current tests pass
- [ ] Current Vercel deployment fails (expected)

### Post-Migration
- [ ] `./dev-start.sh` works
- [ ] `./dev-restart.sh` works
- [ ] `./dev-stop.sh` works
- [ ] Python dev server starts on :9000
- [ ] Frontend can call Python API
- [ ] All tests pass: `cd graph-editor && pytest tests/ -v`
- [ ] Vercel functions work locally: `vercel dev`
- [ ] Vercel functions work in production
- [ ] No 500 errors in production logs

## Alternative Approaches Considered

### Option A: Symlink lib/ into graph-editor/
- **Pros**: No file moves needed
- **Cons**: Vercel doesn't follow symlinks, won't work

### Option B: Copy lib/ into graph-editor/api/lib/
- **Pros**: Minimal changes
- **Cons**: Duplication, maintenance burden, not clean architecture

### Option C: Keep dev infrastructure at root, only move lib/ and requirements.txt
- **Pros**: Less disruption to local dev
- **Cons**: Split Python codebase, confusing, harder to maintain

### Option D: Move everything (CHOSEN)
- **Pros**: Clean, consistent, Vercel-compatible, single source of truth
- **Cons**: More files to update, but one-time migration

## Decision Required

**Please confirm:**
1. ✅ Proceed with moving all Python files to `graph-editor/`?
2. ✅ Move `venv/` or recreate it?
3. ✅ Any concerns about this approach?

Once approved, I will execute the migration step-by-step with verification at each phase.

