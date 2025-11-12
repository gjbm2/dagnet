# Python API Routes Analysis

## Final State: Production-Ready Routes

### ✅ **CRITICAL - Must Deploy to Vercel:**

#### 1. `POST /api/generate-all-parameters` ⭐
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Generate MSMDC queries for ALL parameters (comprehensive)
  - Edge base probabilities (edge.p)
  - Edge conditional probabilities (edge.conditional_p[])
  - Edge costs (cost_gbp, cost_time)
  - Case node variants (node.case.variants[])
- **Used in production**: ✅ YES
- **Client method**: `graphComputeClient.generateAllParameters()` ✅
- **Used in**: `queryRegenerationService.ts` - **CRITICAL PATH**
- **Vercel needed**: ✅ **YES - CRITICAL**
- **File**: `graph-editor/api/generate-all-parameters.py` (to be created)

#### 2. `POST /api/stats-enhance` ⭐
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Enhance raw aggregation with statistical methods (MCMC, Bayesian, trend-aware, robust)
- **Used in production**: ✅ YES
- **Client method**: `graphComputeClient.enhanceStats()` ✅
- **Used in**: `statisticalEnhancementService.ts` - **CRITICAL PATH**
- **Vercel needed**: ✅ **YES - CRITICAL**
- **File**: `graph-editor/api/stats-enhance.py` (to be created)

---

### ⚠️ **OPTIONAL - Useful for Testing/Debugging:**

#### 3. `POST /api/parse-query`
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Parse DSL query string into structured components
- **Used in production**: ❌ No
- **Client method**: `graphComputeClient.parseQuery()` ✅
- **Used in**: Only in tests (`graphComputeClient.test.ts`)
- **Vercel needed**: ⚠️ Optional (useful for debugging DSL parsing, but not production-critical)
- **File**: `graph-editor/api/parse-query.py` (optional)

#### 4. `POST /api/generate-query`
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Generate MSMDC query for single edge
- **Used in production**: ❌ No
- **Client method**: ❌ None (no method calls this)
- **Note**: This is the single-edge version of MSMDC (useful for testing/debugging)
- **Vercel needed**: ⚠️ Optional (useful for testing single-edge queries, but not production-critical)
- **File**: `graph-editor/api/generate-query.py` (optional)

---

### ❌ **NOT NEEDED - Dev-Only or Unused:**

#### 5. `GET /` and `GET /api` - Health Check
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Health check endpoint
- **Used in production**: ❌ No (only for dev server status)
- **Client method**: `graphComputeClient.health()` - exists but only used in tests
- **Vercel needed**: ❌ No (not critical for production)

#### 6. `POST /api/query-graph`
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Apply DSL query to graph (topology filtering)
- **Used in production**: ❌ No
- **Client method**: ❌ None (no method in graphComputeClient)
- **Vercel needed**: ❌ No

#### 7. `POST /api/generate-all-queries`
- **Status**: ✅ Implemented in `dev-server.py`
- **Purpose**: Generate queries for ALL edges (batch MSMDC, base queries only)
- **Used in production**: ❌ No
- **Client method**: ❌ None (no method calls this)
- **Note**: This generates queries for edges only, not all parameters. Superseded by `generate-all-parameters`.
- **Vercel needed**: ❌ No (superseded by generate-all-parameters)

---

## Client Methods (Final State)

### ✅ **Production Methods:**
1. `health()` - Health check (dev/testing only)
2. `parseQuery()` - Parse DSL (testing/debugging)
3. `generateAllParameters()` - **CRITICAL** - Generate MSMDC queries for all parameters
4. `enhanceStats()` - **CRITICAL** - Enhance raw aggregation with statistical methods

### ❌ **Removed (Not Implemented/Not Used):**
- ~~`generateMSMDCQuery()`~~ - Removed (endpoint `/api/msmdc` doesn't exist)
- ~~`applyMutation()`~~ - Removed (endpoint `/api/mutations` doesn't exist)
- ~~`getAnalytics()`~~ - Removed (endpoint `/api/analytics` doesn't exist)

---

## Deployment Plan

### Phase 1: Critical Production Routes (Required)
1. **Create `graph-editor/api/generate-all-parameters.py`**
   - Copy logic from `dev-server.py` `/api/generate-all-parameters` endpoint
   - Format as Vercel serverless function (BaseHTTPRequestHandler)
   - Test locally with `vercel dev`
   - Deploy to production

2. **Create `graph-editor/api/stats-enhance.py`**
   - Copy logic from `dev-server.py` `/api/stats-enhance` endpoint
   - Format as Vercel serverless function (BaseHTTPRequestHandler)
   - Test locally with `vercel dev`
   - Deploy to production

### Phase 2: Optional Testing Routes (Nice to Have)
3. **Create `graph-editor/api/parse-query.py`** (optional)
   - Useful for debugging DSL parsing issues
   - Can be added later if needed

4. **Create `graph-editor/api/generate-query.py`** (optional)
   - Useful for testing single-edge MSMDC queries
   - Can be added later if needed

### Phase 3: Cleanup (Future)
- Mark unused endpoints in `dev-server.py` as "dev-only"
- Document which endpoints are production-critical vs dev-only
- Consider removing or stubbing unused endpoints

---

## Summary

### Routes to Deploy to Vercel:
1. ✅ **`/api/generate-all-parameters`** - **CRITICAL** (production)
2. ✅ **`/api/stats-enhance`** - **CRITICAL** (production)
3. ⚠️ **`/api/parse-query`** - Optional (testing/debugging)
4. ⚠️ **`/api/generate-query`** - Optional (testing/debugging)

### Routes NOT Needed:
- ❌ `/api/msmdc` - Removed from client (endpoint doesn't exist)
- ❌ `/api/mutations` - Removed from client (endpoint doesn't exist)
- ❌ `/api/analytics` - Removed from client (endpoint doesn't exist)
- ❌ `/api/query-graph` - Not used
- ❌ `/api/generate-all-queries` - Superseded by generate-all-parameters
- ❌ `GET /` and `GET /api` - Health check, not critical

---

## Next Steps

1. ✅ **Completed**: Removed unused client methods (`generateMSMDCQuery`, `applyMutation`, `getAnalytics`)
2. ✅ **Completed**: Removed unused type definitions
3. ✅ **Completed**: Removed unused test cases
4. ✅ **Completed**: Created Vercel serverless functions for critical routes:
   - `graph-editor/api/generate-all-parameters.py` ✅
   - `graph-editor/api/stats-enhance.py` ✅
5. 🔄 **Next**: Test locally with `vercel dev`
6. 🔄 **Next**: Deploy to production

## Files Created

### `graph-editor/api/generate-all-parameters.py`
- Vercel serverless function using `BaseHTTPRequestHandler`
- Imports from `lib/msmdc` and `lib/graph_types`
- Handles POST requests with graph data
- Returns formatted parameter queries
- Includes CORS headers

### `graph-editor/api/stats-enhance.py`
- Vercel serverless function using `BaseHTTPRequestHandler`
- Imports from `lib/stats_enhancement`
- Handles POST requests with raw aggregation data
- Returns enhanced statistical results
- Includes CORS headers

## Testing Instructions

### Normal Development Workflow

**Current Setup:**
- Frontend (Vite) runs on `:5173` and uses FastAPI dev-server on `:9000`
- FastAPI dev-server (`dev-server.py`) already has all endpoints implemented
- This is your normal development workflow - no changes needed!

**To run normal dev:**
```bash
# Use the existing dev-start.sh script
./dev-start.sh

# Or manually:
# Terminal 1: FastAPI dev-server
source venv/bin/activate
python dev-server.py  # Runs on :9000

# Terminal 2: Frontend
cd graph-editor
npm run dev  # Runs on :5173, uses :9000 for Python API
```

### Testing Vercel Functions Locally (Pre-Deployment Verification)

**When to use:** Before deploying to production, to verify the Vercel serverless functions work correctly.

**Setup:**
1. Ensure Python virtual environment is set up:
   ```bash
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

**Testing Options:**

**Option A: Test functions directly (recommended for quick verification)**
```bash
# Start Vercel dev server (runs on :3000 by default)
cd graph-editor
vercel dev

# In another terminal, test the functions:
curl -X POST http://localhost:3000/api/generate-all-parameters \
  -H "Content-Type: application/json" \
  -d '{"graph": {...}}'

curl -X POST http://localhost:3000/api/stats-enhance \
  -H "Content-Type: application/json" \
  -d '{"raw": {...}, "method": "mcmc"}'
```

**Option B: Test with frontend pointing to Vercel dev**
```bash
# 1. Start Vercel dev server
cd graph-editor
vercel dev  # Runs on :3000

# 2. In another terminal, start frontend pointing to Vercel:
cd graph-editor
VITE_PYTHON_API_URL=http://localhost:3000 npm run dev

# Frontend will now use Vercel functions instead of FastAPI dev-server
```

**Note:** The FastAPI dev-server (`dev-server.py`) already implements these endpoints and is what you use for normal development. The Vercel functions are for production deployment - testing them locally is optional verification before deploying.

## Deployment Notes

- **Python Runtime**: Vercel will auto-detect `.py` files and use Python 3.9+
- **Dependencies**: Vercel will install packages from `requirements.txt` at project root
- **Path Resolution**: Functions use relative paths to find `lib/` directory
- **Size Limit**: Keep dependencies minimal (numpy/scipy are optional and gracefully degrade)
- **Region**: Configure in `vercel.json` if needed (defaults to closest region)
- **Dev vs Prod**: 
  - **Dev**: Frontend uses FastAPI dev-server (`dev-server.py` on `:9000`) - already working!
  - **Prod**: Frontend uses Vercel serverless functions (`/api/*.py`) - these are what we just created
