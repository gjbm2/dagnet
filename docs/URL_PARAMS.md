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
```

### `?settings=<json>`

**⚠️ Not yet implemented** - Planned for future release

Allows passing application settings via URL parameters.

**Planned usage:**
```
https://dagnet.vercel.app/?settings={"ui":{"theme":"dark"},"development":{"devMode":true}}
```

**Security note:** Credentials will never be accepted via URL parameters for security reasons.

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

1. **No credentials in URLs** - Authentication tokens are never accepted via URL parameters
2. **Data validation** - All URL data is validated before processing
3. **Size limits** - Very large data objects may exceed URL length limits
4. **Clear parameter** - Use with caution as it destroys all local data

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
