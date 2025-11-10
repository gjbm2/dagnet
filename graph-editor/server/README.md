# DAS Proxy Server

This directory contains the proxy server middleware for handling external API requests during development.

## Purpose

The DAS (Data Adapter System) needs to make HTTP requests to external APIs (Amplitude, Google Sheets, etc.). However, browsers block these requests due to CORS (Cross-Origin Resource Sharing) policies. The proxy server solves this by:

1. **Development**: Vite middleware intercepts `/api/das-proxy` requests
2. **Production**: Vercel serverless function at `/api/das-proxy` handles requests

## How It Works

### Client Side (BrowserHttpExecutor)

Instead of making direct requests to external APIs:

```typescript
// ❌ Direct request (blocked by CORS)
fetch('https://amplitude.com/api/2/funnels', { ... })

// ✅ Proxied request (works)
fetch('/api/das-proxy', {
  method: 'POST',
  body: JSON.stringify({
    url: 'https://amplitude.com/api/2/funnels',
    method: 'POST',
    headers: { ... },
    body: '...'
  })
})
```

### Server Side

**Development (Vite):**
- `server/proxy.ts` - Node.js middleware
- Configured in `vite.config.ts` as a plugin
- Runs on same port as dev server (5173)

**Production (Vercel):**
- `api/das-proxy.ts` - Serverless function
- Automatically deployed with the app
- Uses Vercel's edge network

## Request Flow

```
Client (Browser)
  ↓
  POST /api/das-proxy
  {
    url: "https://external-api.com/endpoint",
    method: "POST",
    headers: { "Authorization": "..." },
    body: "{...}"
  }
  ↓
Proxy Server (Vite dev or Vercel)
  ↓
  Forward request to external API
  ↓
External API Response
  ↓
Proxy Server
  ↓
Client receives response (with CORS headers added)
```

## Security

- The proxy adds `Access-Control-Allow-Origin: *` headers
- Authentication credentials are passed through securely
- No credentials are stored server-side
- Request validation ensures only POST requests are proxied

## Testing

To test the proxy locally:

1. Start the dev server: `npm run dev`
2. The proxy will be available at `http://localhost:5173/api/das-proxy`
3. Make a test request from the browser console:

```javascript
fetch('/api/das-proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://httpbin.org/post',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test: 'data' })
  })
}).then(r => r.json()).then(console.log);
```

## Troubleshooting

**Proxy not responding:**
- Check Vite dev server is running
- Verify the URL is `/api/das-proxy` (not `/api/das-proxy/`)
- Check browser console for errors

**Still getting CORS errors:**
- Ensure `BrowserHttpExecutor.useProxy` is `true` (default)
- Clear browser cache and reload
- Check the request is going through the proxy (look for "Proxying" in console)

**Production issues:**
- Verify `api/das-proxy.ts` is deployed to Vercel
- Check Vercel function logs for errors
- Ensure environment variables are set correctly

