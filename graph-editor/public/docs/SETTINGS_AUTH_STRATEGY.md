# Credential Management Strategy

## Overview

This document outlines the credential management architecture for the DagNet Graph Editor, supporting both user-driven editing and automated system operations through a unified credential schema with different storage mechanisms.

## Architecture: Three-Tier Authentication

### Core Principle
- **Tier 1: Public Users** - No access without credentials
- **Tier 2: Authenticated Users** - Browser-stored personal credentials
- **Tier 3: External Tools** - API access with system credentials + secret

### Benefits
- Simple security model (secret parameter)
- User flexibility (personal tokens)
- System automation (environment credentials)
- Commercial protection (no access without secret)

## Unified Credential Schema

### Minimal Schema with Sensible Defaults

The credential schema is designed to be minimal with sensible defaults, supporting multiple git repositories per credential set:

```json
{
  "git": [{
    "name": "Repository Name",
    "owner": "github-username",
    "repo": "repository-name",
    "token": "ghp_...",
    "basePath": "optional-prefix",
    "branch": "main",
    "graphsPath": "graphs",
    "paramsPath": "parameters",
    "contextsPath": "contexts",
    "casesPath": "cases"
  }],
  "statsig": {
    "token": "statsig_console_api_key"
  },
  "googleSheets": {
    "token": "google_oauth_token"
  }
}
```

### Key Design Principles

1. **Minimal Required Fields**: Only name, owner, repo, and token are required for git repos
2. **Sensible Defaults**: Directory structure defaults to standard layout
3. **Multiple Repos**: Git supports array for multiple repositories per credential set
4. **Single Service Configs**: Other services use single objects (one config per service type)
5. **Base Path Support**: Handles different repository structures (root vs nested)

## Storage Mechanisms

### 1. User Credentials (Browser IndexedDB)
- **Purpose**: Interactive editing by users
- **Storage**: Browser IndexedDB
- **Scope**: User's personal repos or org repos they have access to
- **Traceability**: Commits from actual user accounts

### 2. System Credentials (Vercel Environment Variables)
- **Purpose**: Automated updates from webhooks/integrations
- **Storage**: `API_CREDS_JSON` environment variable
- **Scope**: System repos for param/case updates
- **Traceability**: Commits from `system-user@yourcompany.com`

### 3. External Tool Credentials (API Parameters)
- **Purpose**: Third-party tools calling our API
- **Storage**: Passed via API calls
- **Scope**: Based on provided credentials
- **Traceability**: Commits from tool-specific accounts

## Security Model

### Three-Tier Access Control

#### 1. **Public Users** (No Access)
- Open app → No repositories accessible
- Must add personal credentials to access any repos
- Perfect for exploration without sensitive data exposure

#### 2. **Authenticated Users** (Browser Credentials)
- User adds GitHub token to IndexedDB
- Can access repos their token permits
- Full interactive editing with personal traceability
- Credentials persist across sessions

#### 3. **External Tools** (API + Secret)
- Tools call Vercel API with `?secret=xyz`
- Vercel validates secret against `WEBHOOK_SECRET` env var
- Loads system credentials from `API_CREDS_JSON` env var
- Automated updates with system traceability

### Security Implementation

#### Vercel Environment Variables
```bash
# Webhook security
WEBHOOK_SECRET=abc123xyz

# System credentials for automated updates (array of credential sets)
API_CREDENTIALS=[
  {
    "secret": "abc123",
    "name": "statsig-integration",
    "credentials": {
      "git": [{
        "name": "System Repo",
        "owner": "yourcompany",
        "repo": "params-repo", 
        "token": "ghp_system_token"
      }],
      "statsig": {
        "token": "statsig_console_api_key"
      }
    }
  },
  {
    "secret": "def456",
    "name": "mcmc-runs",
    "credentials": {
      "git": [{
        "name": "MCMC Repo",
        "owner": "yourcompany",
        "repo": "mcmc-results",
        "token": "ghp_mcmc_token"
      }]
    }
  }
]
```

#### API Endpoint Security
```typescript
// External tool calls (require secret)
POST /api/webhooks/statsig?secret=abc123xyz
POST /api/external/update-priors?secret=abc123xyz
POST /api/external/sync-sheets?secret=abc123xyz

// User calls (no secret needed, use browser credentials)
GET /api/git/contents/owner/repo/path
POST /api/git/contents/owner/repo/path
```

## Implementation Details

### Credential Loading Logic

```typescript
// Vercel API function
const secret = req.query.secret;
if (!secret) {
  return 401; // No secret provided
}

// Load all credential sets
const allCredSets = JSON.parse(process.env.API_CREDENTIALS);
const credSet = allCredSets.find(cs => cs.secret === secret);

if (!credSet) {
  return 401; // Invalid secret
}

// Use credSet.credentials for operations
const gitToken = credSet.credentials.git[0].token;
const statsigToken = credSet.credentials.statsig?.token;
```

```typescript
// Browser client
// Load user credentials from IndexedDB
const userCreds = await loadFromIndexedDB('credentials');
// Use userCreds.git[0].auth.token for Git operations
```

### Future Extensions

#### URL Credential Passing (Optional)
```typescript
// Future: Pass credentials via URL for sharing
https://app.com/?creds={
  "git": [{"name": "Temp Repo", "auth": {"type": "token", "token": "ghp_temp"}}]
}

// App loads URL creds, shows warning, replaces existing
const urlCreds = parseURLCredentials();
await saveToIndexedDB('credentials', urlCreds);
window.location.reload();
```

#### User Acting as System (Debug Mode)
```typescript
// User clicks "Load System Credentials"
const secret = prompt("Enter system secret:");
if (secret === process.env.WEBHOOK_SECRET) {
  // Load system creds from ENV VAR
  const systemCreds = JSON.parse(process.env.API_CREDS_JSON);
  // Replace user's IndexedDB creds temporarily
  await saveToIndexedDB('credentials', systemCreds);
  // Reload app state
  window.location.reload();
}
```

## Implementation Plan

### Phase 1: Credential Schema
- [ ] Create unified credential schema (git, statsig, googleSheets, thirdParty)
- [ ] Implement schema validation
- [ ] Create credential management UI components

### Phase 2: Storage Implementation
- [ ] Browser IndexedDB storage for user credentials
- [ ] Vercel environment variable loading for system credentials
- [ ] Credential loading and validation logic

### Phase 3: Security Implementation
- [ ] Secret parameter validation for API endpoints
- [ ] Environment variable configuration
- [ ] API endpoint security middleware

### Phase 4: Integration Testing
- [ ] Test user credential flow (browser)
- [ ] Test system credential flow (webhooks)
- [ ] Test external tool integration

## Use Cases

### 1. **Routine Editing** (Tier 2: Browser Auth)
- User opens app normally
- Adds GitHub token to IndexedDB via credentials UI
- Full interactive editing with immediate saves
- Credentials persist across sessions
- Commits traceable to user account

### 2. **Statsig Webhook** (Tier 3: System Auth)
```bash
# Statsig calls webhook with secret
curl -X POST https://dagnet.vercel.app/api/webhooks/statsig?secret=abc123xyz \
  -H "Content-Type: application/json" \
  -d '{"caseId": "variant_a", "weight": 0.25}'

# Vercel function:
# 1. Validates secret
# 2. Loads system credentials from API_CREDS_JSON
# 3. Calls Statsig API to get full case data
# 4. Updates Git repo with system token
# 5. Commits as "system-user@yourcompany.com"
```

### 3. **MCMC Batch Runs** (Tier 3: System Auth)
```bash
# MCMC tool calls API with secret
curl -X POST https://dagnet.vercel.app/api/external/update-priors?secret=abc123xyz \
  -H "Content-Type: application/json" \
  -d '{"priors": {...}, "repository": "yourcompany/params-repo"}'
```

### 4. **Google Sheets Integration** (Tier 3: System Auth)
```bash
# Google Sheets webhook with secret
curl -X POST https://dagnet.vercel.app/api/external/sync-sheets?secret=abc123xyz \
  -H "Content-Type: application/json" \
  -d '{"sheet_id": "123", "updates": {...}}'
```

### 5. **Public Demo** (Tier 1: No Auth)
- User opens app without credentials
- No repositories accessible
- Must add personal credentials to access any data
- Perfect for controlled exploration

## Security Considerations

1. **Credential Storage**
   - User credentials: Browser IndexedDB only
   - System credentials: Vercel environment variables only
   - No server-side credential storage beyond env vars

2. **API Security**
   - Secret parameter validation for all external tool endpoints
   - HTTPS required for all operations
   - No credentials in URL parameters (except future optional feature)

3. **Token Management**
   - System tokens: Scoped to specific repos only
   - User tokens: Respect user's GitHub permissions
   - Clear credentials on logout/clear data

4. **Traceability**
   - All Git commits include proper author information
   - System commits: `system-user@yourcompany.com`
   - User commits: Actual user account
   - Audit trail for all credential usage

## Key Design Decisions

1. **No Credential Blending** - Simple, clean separation
2. **Unified Schema** - Same structure for all credential types
3. **Secret-Based Security** - Simple but effective for serverless
4. **Environment Variable Storage** - Secure system credential management
5. **Browser Storage** - User convenience with personal control

This architecture provides a clean separation between user and system operations while maintaining security and traceability.

## Future Extensions

### Time-Limited Credential Sharing

For sharing credentials with time limits (e.g., 7 days), the system supports encrypted URL-based credential sharing:

#### Implementation
```typescript
// Generate shareable URL with expiry
const generateShareableURL = async (userCreds, days = 7) => {
  const response = await fetch('/api/encrypt-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credentials: userCreds,
      expires: Date.now() + (days * 24 * 60 * 60 * 1000)
    })
  });
  
  const { encrypted } = await response.json();
  return `https://dagnet.vercel.app/?creds=${encodeURIComponent(encrypted)}`;
};

// Load credentials from URL
const loadCredentialsFromURL = async (encryptedCreds) => {
  const response = await fetch('/api/decrypt-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted: encryptedCreds })
  });
  
  const { credentials, expires } = await response.json();
  
  if (Date.now() > expires) {
    throw new Error('Credentials expired');
  }
  
  return credentials;
};
```

#### Vercel Environment Variables
```bash
# Additional env var for credential sharing
CREDS_ENCRYPTION_KEY=your-32-character-secret-key-here
```

#### Security Properties
- ✅ **Encryption key never exposed** to client
- ✅ **Server-side encryption/decryption** only
- ✅ **Time-limited** credentials (automatic expiry)
- ✅ **Tamper-proof** (any modification breaks decryption)
- ✅ **Revocable** (change encryption key to invalidate all URLs)

#### Usage Example
1. **Alice** clicks "Share for 7 days" → gets encrypted URL
2. **Alice** sends URL to **Bob**
3. **Bob** opens URL → app decrypts and loads Alice's credentials
4. **Bob** can access Alice's repos for 7 days
5. **After 7 days** → URL stops working automatically

This feature is **not part of the core build** but can be added as a future enhancement.
