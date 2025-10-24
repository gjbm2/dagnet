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

**Examples:**

```bash
# Get graph metadata and content
GET /api/graph?name=bsse-conversion-4&branch=main

# Get raw JSON string (for Google Sheets)
GET /api/graph?name=bsse-conversion-4&branch=main&raw=true&format=pretty
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

- `VITE_GIT_REPO_OWNER`: GitHub repository owner (default: gjbm2)
- `VITE_GIT_REPO_NAME`: GitHub repository name (default: nous-conversion)
- `VITE_GIT_GRAPHS_PATH`: Path to graphs directory (default: graphs)
- `VITE_GITHUB_TOKEN`: GitHub personal access token (optional, for private repos)

## Google Sheets Integration

Use with `dagGetGraph()`:

```javascript
=dagGetGraph("bsse-conversion-4", "main")
```

Or with a direct URL:

```javascript
=dagGetGraph("https://dagnet-nine.vercel.app/api/graph?name=bsse-conversion-4&branch=main&raw=true&format=pretty")
```

## Deployment

The API is automatically deployed when you deploy the graph-editor to Vercel. Vercel auto-detects the `/api` directory and creates serverless functions.

Make sure to set the environment variables in your Vercel project settings.

