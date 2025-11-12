# DAS Credential Resolution Specification

## Overview

This document specifies how the DAS Runner resolves and injects credentials from `credentials.yaml` into adapter templates.

## Credential Storage Structure

### credentials.yaml Format

```yaml
version: "1.0.0"

# Git credentials (existing structure - unchanged)
git:
  - name: nous-conversion
    owner: gjbm2
    token: "ghp_..."
    # ... other git config

# Generic provider credentials (NEW)
providers:
  # Key matches 'credsRef' in connections.yaml
  amplitude:
    api_key: "abc123"
    secret_key: "xyz789"
  
  google-sheets:
    # Option 1: Service Account (for server-side)
    service_account_json_b64: "eyJ0eXBlIjoi..."
    # Option 2: OAuth token (for client-side)
    access_token: "ya29...."
  
  statsig:
    console_api_key: "console-..."
  
  postgres-analytics:
    host: "db.example.com"
    port: 5432
    database: "analytics"
    username: "readonly"
    password: "secret123"
  
  # Any arbitrary provider with any fields
  custom-api:
    bearer_token: "..."
    endpoint_override: "..."
```

## Resolution Flow

### Step 1: Connection References Credentials

```yaml
# connections.yaml
connections:
  - name: amplitude-prod
    credsRef: amplitude  # ← Points to providers.amplitude
    adapter:
      request:
        headers:
          Authorization: "Basic {{credentials.api_key}}:{{credentials.secret_key}}"
```

### Step 2: DAS Loads Credentials

```typescript
// Pseudocode for DAS Runner
class DASRunner {
  async execute(connection: Connection, dsl: DSL, window: Window, context: Context) {
    // 1. Resolve credentials
    const credsRef = connection.credsRef;  // "amplitude"
    const rawCredentials = await this.credentialsManager.getProvider(credsRef);
    // Returns: { api_key: "abc123", secret_key: "xyz789" }
    
    // 2. Compute derived values
    const credentials = this.computeDerivedCredentials(rawCredentials);
    // Returns: { 
    //   api_key: "abc123", 
    //   secret_key: "xyz789",
    //   basic_auth_b64: "YWJjMTIzOnh5ejc4OQ=="  // auto-computed
    // }
    
    // 3. Build template context
    const templateContext = {
      credentials,
      dsl,
      window,
      context,
      defaults: connection.defaults,
      connection_string: connectionString  // from parameter
    };
    
    // 4. Render templates
    const url = Mustache.render(connection.adapter.request.url_template, templateContext);
    const body = Mustache.render(connection.adapter.request.body_template, templateContext);
    // ...
  }
}
```

### Step 3: Template Expansion

```mustache
Authorization: "Basic {{credentials.api_key}}:{{credentials.secret_key}}"
→ Authorization: "Basic abc123:xyz789"

Authorization: "Basic {{credentials.basic_auth_b64}}"
→ Authorization: "Basic YWJjMTIzOnh5ejc4OQ=="

url_template: "{{credentials.host}}:{{credentials.port}}/{{credentials.database}}"
→ "db.example.com:5432/analytics"
```

## Auto-Computed Credential Fields

The DAS automatically computes common derived values:

| Source Fields | Computed Field | Formula |
|---|---|---|
| `api_key`, `secret_key` | `basic_auth_b64` | `btoa(api_key + ":" + secret_key)` |
| `service_account_json_b64` | `service_account_json` | `atob(service_account_json_b64)` → parsed JSON |
| Any `*_b64` field | `*` (without suffix) | Base64 decode |

**Example:**
```typescript
// Input credentials
{
  api_key: "abc123",
  secret_key: "xyz789",
  custom_token_b64: "dG9rZW4="
}

// After auto-computation
{
  api_key: "abc123",
  secret_key: "xyz789",
  basic_auth_b64: "YWJjMTIzOnh5ejc4OQ==",  // ← auto-added
  custom_token_b64: "dG9rZW4=",
  custom_token: "token"  // ← auto-decoded
}
```

## CredentialsManager Interface

### Existing Implementation

The existing `CredentialsManager` (`lib/credentials.ts`) already supports:
- **IndexedDB credentials** (user-managed, stored locally)
- **URL credentials** (passed via query param, session-only)
- **System credentials** (from `VITE_CREDENTIALS_JSON` env var for server-side)

### Required Extensions

Add new method to access provider credentials:

```typescript
interface CredentialsManager {
  // Existing methods
  loadCredentials(): Promise<CredentialsResult>;
  
  // NEW: Provider-specific credential access
  getProviderCredentials(providerKey: string): Promise<Record<string, any> | null>;
}

// Implementation
class CredentialsManagerImpl {
  async getProviderCredentials(providerKey: string): Promise<Record<string, any> | null> {
    const result = await this.loadCredentials();
    if (!result.success || !result.credentials) {
      return null;
    }
    
    // Look up in providers object
    return result.credentials.providers?.[providerKey] || null;
  }
}
```

### Usage in DAS Runner

```typescript
const credentials = await credentialsManager.getProviderCredentials(connection.credsRef);
if (!credentials) {
  throw new Error(`Credentials not found for provider: ${connection.credsRef}`);
}
```

## Security Considerations

### 1. Credential Masking in Logs

When logging requests/responses, mask credential values:

```typescript
function maskCredentials(obj: any): any {
  const MASK = "***REDACTED***";
  const SENSITIVE_KEYS = [
    'api_key', 'secret_key', 'password', 'token', 
    'access_token', 'bearer_token', 'basic_auth_b64'
  ];
  
  // Recursively mask sensitive fields
  // ...
}
```

### 2. Template Security

Credentials in templates are unavoidable, but we can:
- Never log the raw template context
- Never return credentials in API responses
- Mask credentials in `evidence.debug_trace`

### 3. Storage Security

- **Client-side**: Credentials stored in IndexedDB (encrypted if possible)
- **Server-side**: Credentials from environment variables only
- **Never commit**: `.gitignore` should exclude `credentials.yaml`

## Example: Complete Flow

### credentials.yaml
```yaml
providers:
  amplitude:
    api_key: "12345"
    secret_key: "abcde"
```

### connections.yaml
```yaml
connections:
  - name: amplitude-prod
    credsRef: amplitude
    adapter:
      request:
        url_template: "https://amplitude.com/api/2/funnels"
        headers:
          Authorization: "Basic {{credentials.basic_auth_b64}}"
```

### DAS Execution
```typescript
// 1. Load credentials
const rawCreds = await credentialsManager.getProviderCredentials("amplitude");
// → { api_key: "12345", secret_key: "abcde" }

// 2. Compute derived
const credentials = {
  ...rawCreds,
  basic_auth_b64: btoa("12345:abcde")  // → "MTIzNDU6YWJjZGU="
};

// 3. Render template
const headers = Mustache.render({
  Authorization: "Basic {{credentials.basic_auth_b64}}"
}, { credentials });
// → { Authorization: "Basic MTIzNDU6YWJjZGU=" }

// 4. Make HTTP request
const response = await fetch(url, { headers });
```

## Migration from Legacy Format

### Old Format (credentials.yaml)
```yaml
statsig:
  token: "console-..."
googleSheets:
  token: "ya29..."
```

### New Format (credentials.yaml)
```yaml
providers:
  statsig:
    console_api_key: "console-..."
  google-sheets:
    access_token: "ya29..."
```

### Migration Strategy
1. Keep old format fields marked as `[DEPRECATED]` in schema
2. CredentialsManager checks `providers` first, then falls back to legacy fields
3. FormEditor shows warning when legacy fields detected
4. Auto-migration tool to convert old → new format

## Implementation Checklist

- [x] Update credentials schema with `providers` object
- [ ] Extend `CredentialsManager.getProviderCredentials()`
- [ ] Implement auto-computation of derived credentials
- [ ] Add credential masking utilities
- [ ] Update DAS Runner to use credential resolution
- [ ] Add migration warnings in FormEditor
- [ ] Document credential patterns for common providers

## Appendix: Common Provider Patterns

### Amplitude
```yaml
providers:
  amplitude:
    api_key: "..."
    secret_key: "..."
    # Auto-computed: basic_auth_b64
```

### Google Sheets (Service Account)
```yaml
providers:
  google-sheets:
    service_account_json_b64: "..."  # Base64 encoded JSON
    # Auto-computed: service_account_json (parsed)
```

### Google Sheets (OAuth)
```yaml
providers:
  google-sheets-oauth:
    access_token: "ya29..."
    refresh_token: "..."  # For token refresh
```

### Statsig
```yaml
providers:
  statsig:
    console_api_key: "console-..."
```

### PostgreSQL
```yaml
providers:
  postgres-analytics:
    host: "db.example.com"
    port: 5432
    database: "analytics"
    username: "readonly"
    password: "..."
```

### Generic Bearer Token API
```yaml
providers:
  custom-api:
    bearer_token: "..."
```

### Generic API Key Header
```yaml
providers:
  api-service:
    api_key: "..."
    api_key_header: "X-API-Key"  # Custom header name
```

