# DAS Proxy: Local vs Production

## Summary

✅ **Yes, it works identically in both environments!**

The proxy is designed to provide the exact same behavior whether you're running locally with `npm run dev` or deployed to Vercel in production.

---

## Architecture Comparison

### Local Development (`npm run dev`)

```
Browser
  ↓
  POST http://localhost:5173/api/das-proxy
  ↓
Vite Dev Server (localhost:5173)
  ↓
Vite Plugin → server/proxy.ts
  ↓
Node.js fetch() → External API
  ↓
Response → Browser
```

**Key Components:**
- **File:** `server/proxy.ts`
- **Runtime:** Node.js (via Vite middleware)
- **Configuration:** `vite.config.ts` plugin
- **Endpoint:** `http://localhost:5173/api/das-proxy`

### Production (Vercel)

```
Browser
  ↓
  POST https://yourdomain.com/api/das-proxy
  ↓
Vercel Edge Network
  ↓
Serverless Function (api/das-proxy.ts)
  ↓
Node.js fetch() → External API
  ↓
Response → Browser
```

**Key Components:**
- **File:** `api/das-proxy.ts`
- **Runtime:** Vercel Serverless (Node.js)
- **Configuration:** Automatic (Vercel detects `api/*.ts`)
- **Endpoint:** `https://yourdomain.com/api/das-proxy`

---

## What's The Same?

✅ **Endpoint Path:** `/api/das-proxy` in both environments
✅ **Request Format:** Same JSON body structure
✅ **Response Format:** Raw text with original content-type
✅ **CORS Headers:** Both add `Access-Control-Allow-Origin: *`
✅ **Error Handling:** Identical error responses
✅ **Logging:** Same console output format
✅ **Validation:** Same request validation logic

## Implementation Parity

Both implementations:
1. Accept POST requests to `/api/das-proxy`
2. Handle OPTIONS preflight requests
3. Parse incoming JSON with `{ url, method, headers, body }`
4. Forward request to external API using `fetch()`
5. Return raw response body with original content-type
6. Add CORS headers to response
7. Handle errors with 500 status + JSON error object

---

## Client Code (Same in Both)

The `BrowserHttpExecutor` doesn't know or care which environment it's in:

```typescript
// This code works identically in dev and production
const proxyResponse = await fetch('/api/das-proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://amplitude.com/api/2/funnels',
    method: 'POST',
    headers: { 'Authorization': '...' },
    body: '...'
  }),
});
```

**In Dev:**
- Browser resolves `/api/das-proxy` → `http://localhost:5173/api/das-proxy`
- Vite plugin handles the request

**In Production:**
- Browser resolves `/api/das-proxy` → `https://yourdomain.com/api/das-proxy`
- Vercel routes to serverless function

---

## Testing Both Environments

### Test Locally

```bash
# Start dev server
npm run dev

# In browser console:
fetch('/api/das-proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://httpbin.org/post',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test: 'local' })
  })
}).then(r => r.text()).then(console.log);

// Should see: Request logged in terminal
// Response: JSON from httpbin.org
```

### Test Production

```bash
# Deploy to Vercel
git push

# In browser console on deployed site:
fetch('/api/das-proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://httpbin.org/post',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test: 'production' })
  })
}).then(r => r.text()).then(console.log);

// Should see: Request logged in Vercel function logs
// Response: JSON from httpbin.org (identical to local)
```

---

## Differences (Internal Only)

These differences exist in the implementation but are **invisible to the client**:

| Aspect | Local (Vite) | Production (Vercel) |
|--------|--------------|---------------------|
| **Runtime** | Node.js (long-running) | Node.js (cold start) |
| **Request handling** | `IncomingMessage` stream | `VercelRequest` object |
| **Response handling** | `ServerResponse` methods | `VercelResponse` methods |
| **Body parsing** | Manual (Buffer chunks) | Automatic (`req.body`) |
| **Startup time** | Instant (already running) | ~100-500ms cold start |
| **Logs location** | Terminal stdout | Vercel function logs |
| **Hot reload** | Yes (Vite HMR) | No (must redeploy) |

None of these affect the behavior from the client's perspective!

---

## Deployment

### Local Setup

1. Proxy is automatically available when you run `npm run dev`
2. No additional configuration needed
3. Logs appear in your terminal

### Production Setup

1. Commit `api/das-proxy.ts` to git
2. Push to GitHub
3. Vercel automatically detects and deploys it
4. Logs appear in Vercel dashboard

**That's it!** No special configuration required.

---

## Troubleshooting

### Issue: Proxy not working locally

**Check:**
- Is dev server running? (`npm run dev`)
- Is the request going to `/api/das-proxy`?
- Check terminal for proxy logs

### Issue: Proxy not working in production

**Check:**
- Is `api/das-proxy.ts` committed and pushed?
- Check Vercel deployment logs
- Verify function deployed: Vercel Dashboard → Functions tab
- Check Vercel function logs for errors

### Issue: Different behavior in dev vs production

**This should never happen!** If you see different behavior:
1. Check both implementations are in sync
2. Verify request format is identical
3. Check Vercel function logs vs local terminal logs
4. File a bug - this is not expected!

---

## Performance Notes

### Local Development
- ⚡ **Instant:** Proxy is always running
- No cold starts
- Fast iteration/debugging

### Production (Vercel)
- 🔄 **Cold Start:** ~100-500ms first request
- 💨 **Warm:** ~10-50ms subsequent requests (within 5 minutes)
- 🌍 **Edge Cached:** Serverless function runs in region closest to user

For most use cases, even cold starts are fast enough. The proxy adds minimal overhead compared to network latency to external APIs.

---

## Summary

**You don't need to think about the difference!**

The proxy is designed to "just work" in both environments with zero configuration changes. Write your code once, test locally, deploy to production - it all works the same way.

The abstraction is complete. ✅

