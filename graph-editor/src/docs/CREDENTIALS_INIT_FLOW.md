# Credentials Initialization Flow

This document outlines how credentials are loaded and managed during app initialization.

## Overview

The credentials system supports three tiers of authentication:
1. **Public** - No credentials, read-only access to public repositories
2. **User** - Browser-stored credentials for interactive editing
3. **System** - Environment variable credentials for API operations

## Initialization Sequence

### 1. App Startup
```
AppShell.tsx
├── ErrorBoundary
├── DialogProvider
├── CredentialsProvider (NEW)
│   ├── Initialize credentialsService
│   ├── Load user credentials from IndexedDB
│   └── Load system credentials from environment
├── TabProvider
├── NavigatorProvider
└── AppShellContent
```

### 2. CredentialsProvider Initialization

```typescript
// 1. Initialize credentials service
await credentialsService.initialize();

// 2. Load user credentials from IndexedDB
const userCredentials = await db.credentials.toArray();
if (userCredentials.length > 0) {
  this.userCredentials = userCredentials[userCredentials.length - 1];
}

// 3. Load system credentials (server-side only)
// This would be implemented in Vercel functions
```

### 3. Credential Sources

#### User Credentials (Browser Storage)
- **Storage**: IndexedDB `credentials` table
- **Source**: User input via Settings tab
- **Scope**: Interactive editing, Git operations
- **Persistence**: Survives browser restarts
- **Security**: Local to user's browser

#### System Credentials (Environment Variables)
- **Storage**: Vercel environment variables
- **Source**: Deployment configuration
- **Scope**: API operations, webhooks, batch processing
- **Persistence**: Managed by deployment platform
- **Security**: Server-side only, not accessible to browser

### 4. Credential Loading Priority

1. **User credentials** (if available) - for interactive operations
2. **System credentials** (if available) - for API operations
3. **Public access** (fallback) - read-only operations

## Implementation Details

### Database Schema
```typescript
// IndexedDB credentials table
interface CredentialsRecord {
  id: string;                    // Primary key
  source: 'user' | 'system';     // Source type
  timestamp: number;             // Creation time
  version?: string;              // Schema version
  defaultGitRepo?: string;       // Default repository
  git: GitRepositoryCredential[]; // Git credentials
  statsig?: StatsigCredential;   // Statsig credentials
  googleSheets?: GoogleSheetsCredential; // Google Sheets credentials
}
```

### Service Layer
```typescript
class CredentialsService {
  // Singleton pattern
  private static instance: CredentialsService;
  
  // State
  private userCredentials: CredentialsData | null = null;
  private systemCredentials: SystemCredentials | null = null;
  
  // Methods
  async initialize(): Promise<void>
  getCredentials(): CredentialsData | null
  getSystemCredentials(): SystemCredentials | null
  saveUserCredentials(credentials: CredentialsData): Promise<void>
  clearUserCredentials(): Promise<void>
  getDefaultGitCredentials(): GitRepositoryCredential | null
  validateCredentials(credentials: any): boolean
}
```

### Context Integration
```typescript
// CredentialsContext provides:
const {
  credentials,           // Current user credentials
  isLoading,            // Loading state
  error,                // Error state
  saveCredentials,      // Save new credentials
  clearCredentials,     // Clear all credentials
  refreshCredentials,   // Reload from storage
  validateCredentials,  // Validate format
  getDefaultGitCredentials // Get default repo creds
} = useCredentials();
```

## Error Handling

### Initialization Failures
- **User credentials load failure**: Continue with public access
- **System credentials load failure**: Log warning, continue with user credentials
- **Database initialization failure**: Show error, prevent app startup

### Validation Failures
- **Invalid credential format**: Show validation error, prevent save
- **Missing required fields**: Highlight missing fields in UI
- **Duplicate repository names**: Prevent save, show conflict error

## Security Considerations

### Browser Storage
- Credentials stored in IndexedDB (encrypted by browser)
- No credentials in localStorage or sessionStorage
- Clear credentials on "Clear Data and Settings"

### Environment Variables
- System credentials only accessible server-side
- Webhook secret for API authentication
- Encryption key for time-limited sharing

### URL Parameters
- **Never** accept credentials via URL parameters
- Only accept repository configuration (no tokens)
- Validate all URL parameters before processing

## Future Extensions

### Time-Limited Credential Sharing
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
```

### Multi-Repository Support
- Support multiple Git repositories
- Default repository selection
- Repository-specific credential management

## Testing

### Local Development
- Use `.env.local` for system credentials
- Mock credentials service for unit tests
- Test credential validation and error handling

### Production
- Vercel environment variables for system credentials
- User credentials stored in IndexedDB
- API endpoints for credential management
