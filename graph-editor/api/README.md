# Dagnet API

Vercel serverless functions for Dagnet graph operations.

## Endpoints

### GET /api/graph

Fetches a graph from the configured GitHub repository.

**Query Parameters:**
- `name` (required): Graph name (with or without .json extension)
- `branch` (optional): Git branch name (default: main)
- `raw` (optional): Return raw JSON string instead of wrapped response (default: false)
- `format` (optional): Format JSON with indentation when raw=true (default: false)
- `secret` (optional): Webhook secret for authentication (enables system credentials)

**Examples:**

```bash
# Get graph metadata and content
GET /api/graph?name=bsse-conversion-4&branch=main

# Get raw JSON string (for Google Sheets)
GET /api/graph?name=bsse-conversion-4&branch=main&raw=true&format=pretty

# Get graph with authentication (uses system credentials)
GET /api/graph?name=bsse-conversion-4&branch=main&raw=true&format=pretty&secret=your-webhook-secret
```

**Response (raw=false):**
```json
{
  "success": true,
  "data": {
    "name": "bsse-conversion-4",
    "path": "graphs/bsse-conversion-4.json",
    "branch": "main",
    "sha": "abc123...",
    "size": 1234,
    "content": { /* graph JSON */ }
  }
}
```

**Response (raw=true):**
```json
{
  "nodes": [...],
  "edges": [...]
}
```

## Environment Variables

Configure these in Vercel:

**System Credentials (Recommended):**
- `CREDS_SYSTEM_JSON`: JSON string containing git, statsig, and googleSheets credentials
- `WEBHOOK_SECRET`: Secret key for authenticating API requests

**Legacy Environment Variables (Fallback):**
- `VITE_GIT_REPO_OWNER`: GitHub repository owner (default: gjbm2)
- `VITE_GIT_REPO_NAME`: GitHub repository name (default: <private-repo>)
- `VITE_GIT_GRAPHS_PATH`: Path to graphs directory (default: graphs)
- `VITE_GITHUB_TOKEN`: GitHub personal access token (optional, for private repos)

## Google Sheets Integration

The Apps Script automatically includes the secret parameter when calling the API. Configure the secret in Google Sheets:

1. Go to `Dagnet → Set Secret` in the Google Sheets menu
2. Enter your webhook secret (must match `WEBHOOK_SECRET` in Vercel)
3. Use `dagGetGraph()` function:

```javascript
=dagGetGraph("bsse-conversion-4", "main")
```

The secret will be automatically appended to the API call. You can also use a direct URL:

```javascript
=dagGetGraph("https://dagnet-nine.vercel.app/api/graph?name=bsse-conversion-4&branch=main&raw=true&format=pretty&secret=your-secret")
```

## Deployment

The API is automatically deployed when you deploy the graph-editor to Vercel. Vercel auto-detects the `/api` directory and creates serverless functions.

Make sure to set the environment variables in your Vercel project settings.

