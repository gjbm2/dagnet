# URL Parameters

The DagNet Graph Editor supports several URL parameters for configuration and data loading.

## Supported Parameters

### `?data=<json_data>`

Loads graph data directly from a JSON object in the URL. Supports both compressed and uncompressed formats.

**Supported formats:**
1. **LZ-string compression** (original format)
2. **Apps Script gzip compression** (base64 + gzip)
3. **Plain JSON** (uncompressed, URL-encoded)

**Usage:**
```
https://dagnet.vercel.app/?data=<json_data>
```

**Examples:**
```
# Compressed (LZ-string)
https://dagnet.vercel.app/?data=eyJub2RlcyI6W3siaWQiOiJhIiwiZGF0YSI6eyJsYWJlbCI6IkEiLCJwcm9iYWJpbGl0eSI6MC41fX1dLCJlZGdlcyI6W119

# Uncompressed (URL-encoded JSON)
https://dagnet.vercel.app/?data=%7B%22nodes%22%3A%5B%7B%22id%22%3A%22a%22%2C%22data%22%3A%7B%22label%22%3A%22A%22%2C%22probability%22%3A0.5%7D%7D%5D%2C%22edges%22%3A%5B%5D%7D
```

**How it works:**
- The app attempts to decompress the data using multiple methods
- If successful, the graph data is loaded into a new tab as "Shared Graph"
- If decompression fails, an error is shown
- URL parameter is cleaned up after loading

### `?graph=<graph_name>`

Opens a specific graph from the default repository by name.

### `?retrieveall=<graph_name>` / `?graph=<graph_name>&retrieveall`

Runs a **headless daily automation** workflow for a specific graph:

- Pull latest from git (**remote wins** for any merge conflicts)
- Retrieve All Slices (headless; no Retrieve All modal)
- Commit all committable changes back to the repo

This is intended for simple local schedulers (e.g. Windows Task Scheduler) on a machine left running.

**Examples:**
```
https://dagnet.vercel.app/?retrieveall=conversion-funnel
https://dagnet.vercel.app/?graph=conversion-funnel&retrieveall
https://dagnet.vercel.app/?retrieveall=conversion-funnel&pullalllatest
```

**How it works:**
- The app opens the graph tab (same as `?graph=`).
- After the graph loads, it runs the workflow via service-layer code (no UI prompts).
- Merge conflicts during pull are automatically resolved by accepting the **remote** version.
- A commit is made only if there are committable file changes.
- The commit message includes a UK date (`d-MMM-yy`), e.g. `Daily data refresh (conversion-funnel) - 18-Dec-25`.
- URL parameters are cleaned up after the automation starts (so refresh won’t repeatedly run it).

### `?pullalllatest`

Pulls the latest repository changes **before** processing any other URL parameters (e.g. `graph`, `parameter`, `context`, `case`, `node`, `data`).

This is useful for shared links where you want the app to self-update first:

```
https://dagnet.vercel.app/?graph=conversion-flow-v2-recs-collapsed&pullalllatest
```

**How it works:**
- Runs the same “Pull All Latest” operation as the UI (incremental, 3-way merge).
- Uses the repository/branch currently selected in Navigator; if none is selected yet, it falls back to `defaultGitRepo` from credentials.
- If the pull fails (e.g. missing credentials), the app continues and still attempts to load the requested file.
- The `pullalllatest` parameter is removed from the URL after it runs (so refresh won’t repeatedly pull).

**Usage:**
```
https://dagnet.vercel.app/?graph=<graph_name>
```

**Examples:**
```
https://dagnet.vercel.app/?graph=conversion-funnel
https://dagnet.vercel.app/?graph=user-journey
https://dagnet.vercel.app/?graph=ab-test-analysis
```

**How it works:**
- Loads the graph from the default repository (configured in settings)
- Opens the graph in a new tab with interactive view
- URL parameter is cleaned up after loading
- If the graph doesn't exist, an error is shown

### `?parameter=<parameter_name>`

Opens a specific parameter file from the default repository for editing.

**Usage:**
```
https://dagnet.vercel.app/?parameter=<parameter_name>
```

**Examples:**
```
https://dagnet.vercel.app/?parameter=conversion-rate
https://dagnet.vercel.app/?parameter=click-probability
https://dagnet.vercel.app/?parameter=user-segment-weights
```

**How it works:**
- Loads the parameter from `parameters/<name>.yaml` in the default repository
- Opens the parameter in a new tab with form editor
- URL parameter is cleaned up after loading
- If the parameter doesn't exist, an error is shown

### `?context=<context_name>`

Opens a specific context file from the default repository for editing.

**Usage:**
```
https://dagnet.vercel.app/?context=<context_name>
```

**Examples:**
```
https://dagnet.vercel.app/?context=mobile-users
https://dagnet.vercel.app/?context=high-value-customers
https://dagnet.vercel.app/?context=test-environment
```

**How it works:**
- Loads the context from `contexts/<name>.yaml` in the default repository
- Opens the context in a new tab with form editor
- URL parameter is cleaned up after loading
- If the context doesn't exist, an error is shown

### `?case=<case_name>`

Opens a specific case file from the default repository for editing.

**Usage:**
```
https://dagnet.vercel.app/?case=<case_name>
```

**Examples:**
```
https://dagnet.vercel.app/?case=ab-test-variant-a
https://dagnet.vercel.app/?case=control-group
https://dagnet.vercel.app/?case=high-conversion-scenario
```

**How it works:**
- Loads the case from `cases/<name>.yaml` in the default repository
- Opens the case in a new tab with form editor
- URL parameter is cleaned up after loading
- If the case doesn't exist, an error is shown

### `?node=<node_name>`

Opens a specific node file from the default repository for editing.

**Usage:**
```
https://dagnet.vercel.app/?node=<node_name>
```

**Examples:**
```
https://dagnet.vercel.app/?node=landing-page
https://dagnet.vercel.app/?node=checkout-flow
https://dagnet.vercel.app/?node=confirmation-page
```

**How it works:**
- Loads the node from `nodes/<name>.yaml` in the default repository
- Opens the node in a new tab with form editor
- URL parameter is cleaned up after loading
- If the node doesn't exist, an error is shown

### `?clear`

Clears all local application data and reloads the page (preserves settings).

**Usage:**
```
https://dagnet.vercel.app/?clear
```

**What it clears:**
- All cached files
- All open tabs
- Application state
- Layout preferences
- **Note:** Settings are preserved (user preferences)

**How it works:**
1. Detects the `?clear` parameter on app load
2. Calls `db.clearAll()` to clear IndexedDB
3. Removes the `?clear` parameter from URL
4. Reloads the page to start fresh

### `?clearall`

Clears ALL data including settings and reloads the page.

**Usage:**
```
https://dagnet.vercel.app/?clearall
```

**What it clears:**
- All cached files
- All open tabs
- Application state
- Layout preferences
- **All settings** (user preferences, themes, etc.)
- Credentials and authentication data

**How it works:**
1. Detects the `?clearall` parameter on app load
2. Calls `db.clearAll()` AND `db.settings.clear()`
3. Removes the `?clearall` parameter from URL
4. Reloads the page to start completely fresh

**Use cases:**
- Complete reset for testing
- Clearing sensitive data
- Starting with factory defaults

## Quick Editing Environments

You can combine multiple parameters to quickly set up editing environments:

### Single File Editing
```
# Edit a specific graph
https://dagnet.vercel.app/?graph=conversion-funnel

# Edit a specific parameter
https://dagnet.vercel.app/?parameter=click-probability

# Edit a specific context
https://dagnet.vercel.app/?context=mobile-users

# Edit a specific case
https://dagnet.vercel.app/?case=ab-test-variant-a
```

### Multi-File Editing
You can open multiple files by combining parameters (though only the first one will be processed automatically):

```
# This will open the graph, but you can manually open the parameter
https://dagnet.vercel.app/?graph=conversion-funnel&parameter=click-probability

# Open a node definition
https://dagnet.vercel.app/?node=landing-page
```

**Note:** Currently, only the first parameter is processed automatically. Future versions may support opening multiple files simultaneously.

### Data Sharing
```
# Share a complete graph with someone
https://dagnet.vercel.app/?data=<compressed_json>

# Share a specific graph from the repo
https://dagnet.vercel.app/?graph=conversion-funnel
```

### Development & Testing
```
# Start fresh for testing
https://dagnet.vercel.app/?clear

# Complete reset including settings
https://dagnet.vercel.app/?clearall

# Load test data
https://dagnet.vercel.app/?data={"nodes":[...],"edges":[...]}

# Enable dev mode with custom settings
https://dagnet.vercel.app/?settings={"development":{"devMode":true,"debugGitOperations":true}}

# Load credentials for testing
https://dagnet.vercel.app/?secret=test-secret-key
```

### Authentication & Configuration
```
# Load from system credentials
https://dagnet.vercel.app/?secret=production-secret

# Configure multiple repositories
https://dagnet.vercel.app/?settings={"repositories":[{"name":"repo1","repoOwner":"org1","repoName":"repo1"}]}

# Pre-configure and load graph
https://dagnet.vercel.app/?secret=my-secret&graph=conversion-funnel
```

### `?settings=<json>`

**✅ Now implemented**

Allows passing application settings via URL parameters.

**Usage:**
```
https://dagnet.vercel.app/?settings=<url_encoded_json>
```

**Examples:**
```
# Set theme to dark and enable dev mode
https://dagnet.vercel.app/?settings=%7B%22development%22%3A%7B%22devMode%22%3Atrue%7D%7D

# Configure multiple repositories
https://dagnet.vercel.app/?settings=%7B%22repositories%22%3A%5B%7B%22name%22%3A%22my-repo%22%2C%22repoOwner%22%3A%22my-org%22%2C%22repoName%22%3A%22my-repo%22%7D%5D%7D
```

**Supported settings:**
- `development.devMode`: Enable development mode
- `development.debugGitOperations`: Enable Git operation debugging
- `repositories`: Array of repository configurations (name, repoOwner, repoName)

**Security note:** Authentication tokens and permissions cannot be passed via URL for security reasons. Use `?secret` or `?creds` parameters for authentication.

### `?secret=<secret_key>`

Loads system credentials using a secret key stored in environment variables.

**Usage:**
```
https://dagnet.vercel.app/?secret=<secret_key>
```

**How it works:**
1. The secret key is sent to the backend
2. Backend retrieves encrypted credentials from environment variables
3. Credentials are decrypted and returned to the client
4. Credentials are stored in IndexedDB for the session
5. URL parameter is cleaned up after loading

**Use cases:**
- Serverless deployments with environment-based credentials
- Shared environments where credentials shouldn't be in URLs
- Production deployments with centralized credential management

**Security note:** The secret key itself doesn't contain credentials, just references them.

### `?creds=<json_credentials>`

Loads credentials directly from a JSON object in the URL.

**Usage:**
```
https://dagnet.vercel.app/?creds=<url_encoded_json>
```

**How it works:**
1. Credentials JSON is decoded from URL
2. Validated against credentials schema
3. Stored in IndexedDB for the session
4. URL parameter is cleaned up after loading

**Supported formats:**
- Plain JSON (URL-encoded)
- Encrypted credentials string

**Credential structure:**
```json
{
  "version": "1.0.0",
  "git": [
    {
      "name": "my-repo",
      "owner": "my-org",
      "token": "ghp_xxx",
      "branch": "main",
      "isDefault": true
    }
  ],
  "googleSheets": {
    "token": "ya29.xxx"
  },
  "statsig": {
    "token": "secret-xxx"
  }
}
```

**Security warning:** Only use this for temporary testing. Never share URLs with credentials in production.

### `?sheet=<sheet_id>&tab=<tab_name>&row=<row_number>`

**⚠️ Requires Apps Script integration** - Only works when `VITE_APPS_SCRIPT_URL` is configured

Loads graph data from Google Sheets.

**Usage:**
```
https://dagnet.vercel.app/?sheet=1abc123def456&tab=Graphs&row=5
```

**Parameters:**
- `sheet`: Google Sheets document ID
- `tab`: Sheet tab name (defaults to "Graphs")
- `row`: Row number containing the graph data

## Implementation Details

### Data Compression

The `?data` parameter supports multiple compression formats for compatibility:

```typescript
// 1. LZ-string compression (original)
const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(data));

// 2. Apps Script gzip compression
const compressed = btoa(String.fromCharCode(...pako.gzip(JSON.stringify(data))));

// 3. Plain JSON (fallback)
const compressed = encodeURIComponent(JSON.stringify(data));
```

### URL Generation

To create shareable URLs with graph data:

```typescript
import { encodeStateToUrl } from '../lib/shareUrl';

const url = encodeStateToUrl(graphData);
// Returns: https://dagnet.vercel.app/?data=<compressed_data>
```

### Data Loading

The app automatically detects and processes URL parameters on load:

```typescript
// Check for ?data parameter
const urlData = decodeStateFromUrl();
if (urlData) {
  // Load data into new tab
  openTabFromData(urlData);
}

// Check for ?clear parameter
if (urlParams.has('clear')) {
  // Clear all data and reload
  await db.clearAll();
  window.location.reload();
}
```

## Security Considerations

1. **Credential handling**:
   - `?secret` parameter is safe - only references credentials, doesn't contain them
   - `?creds` parameter contains actual credentials - use only for testing
   - Never share URLs with `?creds` in production environments
   - URL parameters with credentials are cleaned up after loading

2. **Data validation** - All URL data is validated before processing

3. **Size limits** - Very large data objects may exceed URL length limits

4. **Clear parameters** - Use with caution as they destroy all local data:
   - `?clear` - Clears app data but preserves settings
   - `?clearall` - Clears everything including credentials

5. **Settings parameter** - Cannot include auth/permissions for security reasons

## Troubleshooting

### Data Parameter Not Working
- Check that the data is properly compressed
- Verify the JSON structure is valid
- Try different compression formats

### Clear Parameter Not Working
- Ensure you have write permissions to IndexedDB
- Check browser console for error messages
- Try manually clearing browser data

### Sheets Integration Not Working
- Verify `VITE_APPS_SCRIPT_URL` is configured
- Check that the Apps Script is deployed and accessible
- Ensure the sheet ID, tab name, and row number are correct
