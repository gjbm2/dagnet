# Registry Deployment Strategy

## Repository Separation

### This Repo (`dagnet/`)
**Purpose:** Graph editor application + schemas

**Contains:**
```
dagnet/
├── graph-editor/              # React app
├── schema/                    # JSON schemas for graphs
│   └── conversion-graph-1.0.0.json
│
└── param-registry/
    ├── schemas/               # YAML schemas (canonical definitions)
    │   ├── context-schema.yaml
    │   ├── parameter-schema.yaml
    │   └── registry-schema.yaml
    │
    └── examples/              # Sample data for development
        ├── contexts.yaml
        ├── registry.yaml
        └── parameters/
            └── (example files)
```

**Purpose of examples:**
- Development and testing
- Documentation and tutorials
- Schema validation examples
- CI/CD testing

---

### Deployment Registry Repo (`dagnet-registry/` or similar)
**Purpose:** Production parameter and context data

**Contains:**
```
dagnet-registry/
├── contexts.yaml              # PRODUCTION context definitions
├── registry.yaml              # PRODUCTION parameter index
│
└── parameters/
    ├── probability/
    │   ├── signup-google.yaml
    │   ├── signup-facebook.yaml
    │   └── ...
    ├── cost/
    └── time/
```

**Characteristics:**
- ✅ Git version controlled
- ✅ Separate permissions (not all devs can edit production params)
- ✅ Change review process (PRs required)
- ✅ Audit trail
- ✅ Rollback capability

---

## Configuration

### Environment-Based Registry Location

**File:** `graph-editor/.env`

```bash
# Development
VITE_PARAM_REGISTRY_URL=http://localhost:3000/param-registry/examples

# Production
VITE_PARAM_REGISTRY_URL=https://raw.githubusercontent.com/yourorg/dagnet-registry/main

# Or from a CDN
VITE_PARAM_REGISTRY_URL=https://cdn.yoursite.com/registry
```

### Loader Configuration

**File:** `graph-editor/src/lib/parameterRegistry.ts`

```typescript
const REGISTRY_BASE_URL = import.meta.env.VITE_PARAM_REGISTRY_URL || '/param-registry/examples';

export async function loadContexts(): Promise<ContextDefinition[]> {
  const url = `${REGISTRY_BASE_URL}/contexts.yaml`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Failed to load contexts from ${url}`);
  }
  
  const yaml = await response.text();
  const data = parseYAML(yaml);
  
  // Validate against schema from local schemas/
  await validateContexts(data);
  
  return data.contexts;
}

export async function loadParameter(parameterId: string): Promise<Parameter> {
  // Find parameter in registry index
  const registryIndex = await loadRegistryIndex();
  const paramPath = registryIndex.parameters.find(p => p.id === parameterId)?.path;
  
  if (!paramPath) {
    throw new Error(`Parameter ${parameterId} not found in registry`);
  }
  
  const url = `${REGISTRY_BASE_URL}/${paramPath}`;
  const response = await fetch(url);
  const yaml = await response.text();
  const param = parseYAML(yaml);
  
  // Validate against schema from local schemas/
  await validateParameter(param);
  
  return param;
}
```

---

## Schema Validation

**Schemas always local (in this repo):**
- Ensures consistent validation across environments
- Version controlled with application code
- Can update schemas in lockstep with application changes

**Validation flow:**
```
1. Fetch data from registry (remote)
2. Load schema from local schemas/ directory
3. Validate data against schema
4. If invalid: reject with detailed error
5. If valid: use data
```

**Implementation:**
```typescript
import contextSchema from '../../../param-registry/schemas/context-schema.yaml';
import parameterSchema from '../../../param-registry/schemas/parameter-schema.yaml';

async function validateContexts(data: any): Promise<void> {
  const validator = new YAMLValidator(contextSchema);
  const result = validator.validate(data);
  
  if (!result.valid) {
    throw new ValidationError('Invalid contexts.yaml', result.errors);
  }
}
```

---

## Development Workflow

### Local Development
```bash
# Use local examples
npm run dev

# Graph editor loads from /param-registry/examples/
```

### Testing Against Production Registry
```bash
# Point to production registry
VITE_PARAM_REGISTRY_URL=https://raw.githubusercontent.com/yourorg/dagnet-registry/main npm run dev

# Or staging
VITE_PARAM_REGISTRY_URL=https://raw.githubusercontent.com/yourorg/dagnet-registry/staging npm run dev
```

### Production Build
```bash
# Production config baked into build
npm run build

# Deployed app fetches from production registry URL
```

---

## Registry Repository Structure

### Example: `dagnet-registry` repo

```
dagnet-registry/
├── README.md
├── .github/
│   └── workflows/
│       ├── validate.yml        # Validate on PR
│       └── deploy.yml          # Deploy to CDN on merge
│
├── contexts.yaml               # Context definitions
├── registry.yaml               # Parameter index
│
├── parameters/
│   ├── probability/
│   │   ├── signup-google.yaml
│   │   ├── signup-facebook.yaml
│   │   ├── checkout-mobile.yaml
│   │   └── ...
│   ├── cost/
│   │   ├── email-campaign-cost.yaml
│   │   └── ...
│   └── time/
│       └── ...
│
└── docs/
    ├── PARAMETER_GUIDE.md
    └── CONTEXT_GUIDE.md
```

### Validation Workflow

**`.github/workflows/validate.yml`**
```yaml
name: Validate Registry

on:
  pull_request:
    branches: [main, staging]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Checkout schemas from dagnet repo
        uses: actions/checkout@v3
        with:
          repository: yourorg/dagnet
          path: schemas-repo
      
      - name: Validate all YAML files
        run: |
          # Install validator
          npm install -g yaml-validator
          
          # Validate contexts
          yaml-validator -s schemas-repo/param-registry/schemas/context-schema.yaml contexts.yaml
          
          # Validate registry
          yaml-validator -s schemas-repo/param-registry/schemas/registry-schema.yaml registry.yaml
          
          # Validate all parameters
          for file in parameters/**/*.yaml; do
            yaml-validator -s schemas-repo/param-registry/schemas/parameter-schema.yaml "$file"
          done
      
      - name: Check for parameter ID conflicts
        run: |
          # Ensure no duplicate parameter IDs
          node schemas-repo/scripts/check-duplicates.js
```

---

## Permissions & Access Control

### GitHub Repository Permissions

**dagnet repo (application):**
- All developers: Write access
- Can modify schemas (with review)
- Can modify example data freely

**dagnet-registry repo (production data):**
- Most developers: Read access only
- Data team: Write access
- Changes require PR + approval
- Automated validation on PR

### Benefits
- ✅ Prevents accidental production data changes
- ✅ Audit trail for parameter changes
- ✅ Can rollback parameter changes independently of code
- ✅ Different release cadence (params can update without code deploy)

---

## Cache Strategy

### Browser Caching
```typescript
// Cache contexts for session (they rarely change)
let contextsCache: ContextDefinition[] | null = null;

export async function loadContexts(): Promise<ContextDefinition[]> {
  if (contextsCache) return contextsCache;
  
  const data = await fetchContexts();
  contextsCache = data;
  return data;
}

// Invalidate cache on user request
export function invalidateCache() {
  contextsCache = null;
  parametersCache.clear();
}
```

### Service Worker Caching
```javascript
// Cache registry files with strategy:
// - Contexts: Cache-first (rarely change)
// - Parameters: Network-first with fallback (may update frequently)
// - Schemas: Cache-first (version locked to app version)

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  if (url.pathname.endsWith('contexts.yaml')) {
    // Cache contexts for 24 hours
    event.respondWith(cacheFirst(event.request, 86400));
  }
  
  if (url.pathname.includes('/parameters/')) {
    // Network first for parameters, short cache
    event.respondWith(networkFirst(event.request, 3600));
  }
});
```

---

## Migration Plan

### Phase 1: Current State (Development)
- Everything in `dagnet/param-registry/examples/`
- No separate registry repo yet

### Phase 2: Create Registry Repo
1. Create `dagnet-registry` repo
2. Copy production parameters from examples/
3. Set up validation workflow
4. Configure permissions

### Phase 3: Update Graph Editor
1. Add `VITE_PARAM_REGISTRY_URL` config
2. Update loader to use config
3. Test against both local and remote registries
4. Deploy

### Phase 4: Production Cutover
1. Deploy graph editor with production registry URL
2. Monitor for issues
3. Train team on registry update process

---

## API Gateway (Optional Future)

For better performance and features, consider an API layer:

```
graph-editor → API Gateway → GitHub/CDN Registry
                  ↓
              - Caching
              - Authentication
              - Rate limiting
              - Aggregation
              - Version management
```

**Benefits:**
- Faster response (server-side caching)
- Authentication/authorization
- Parameter usage analytics
- Computed aggregations
- A/B test parameter serving

**Not needed for v1** - Direct GitHub fetching is fine initially

---

## Summary

### Development
```
dagnet/param-registry/
  ├── schemas/ (canonical definitions)
  └── examples/ (sample data for development)
```

### Production
```
dagnet-registry/ (separate repo)
  ├── contexts.yaml (production data)
  ├── registry.yaml (production index)
  └── parameters/ (production parameters)
```

### Configuration
```bash
# .env
VITE_PARAM_REGISTRY_URL=<registry-location>
```

### Validation
- Schemas always from `dagnet` repo
- Data validated against schemas before use
- GitHub Actions validate on PR to registry repo

**This separation provides:**
- ✅ Clear separation of code vs data
- ✅ Independent release cycles
- ✅ Proper access control
- ✅ Git-based version control for parameters
- ✅ Easy rollback of parameter changes



