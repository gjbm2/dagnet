# Why Google Sheets Succeeded But Amplitude Failed (CORS)

## The Problem

When you make HTTP requests from a browser to external APIs, the browser enforces **CORS (Cross-Origin Resource Sharing)** policies. The browser will block requests unless the external server explicitly allows them.

## Why Google Sheets Worked

**Google Sheets API:**
```
URL: https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}
```

✅ **Google APIs are CORS-enabled:**
- Google's public APIs are designed for browser usage
- They send proper CORS headers: `Access-Control-Allow-Origin: *`
- OAuth tokens can be used directly from the browser
- The API expects and handles browser preflight requests

**Example successful flow:**
1. Browser sends OPTIONS preflight → Google responds with CORS headers ✅
2. Browser sends GET request → Google responds with data + CORS headers ✅
3. Success! ✅

## Why Amplitude Failed

**Amplitude Dashboard API:**
```
URL: https://amplitude.com/api/2/funnels
```

❌ **Amplitude's API is NOT CORS-enabled:**
- Designed for server-to-server communication only
- Does **NOT** send `Access-Control-Allow-Origin` headers
- Expects Basic Auth, which triggers CORS preflight
- Browser blocks the request before it even reaches Amplitude

**Example failed flow:**
1. Browser detects cross-origin + auth → sends OPTIONS preflight
2. Amplitude responds without CORS headers (or doesn't respond to OPTIONS)
3. Browser: ❌ `net::ERR_BLOCKED_BY_CLIENT` or `CORS policy: No 'Access-Control-Allow-Origin' header`
4. Request never happens

## Additional Browser Blocks

Even if CORS passed, browsers have other protections:
- **Ad blockers** may block analytics domains like `amplitude.com`
- **Privacy extensions** may block tracking-related requests
- **Enterprise firewalls** may block certain domains

This is why even in an incognito window, you saw `ERR_BLOCKED_BY_CLIENT` - browser extensions can still run in incognito mode.

## The Proxy Solution

Our proxy solves ALL these issues:

```
┌─────────┐                ┌──────────────┐              ┌──────────────┐
│ Browser │                │ Our Proxy    │              │ External API │
│         │                │ (Same Origin)│              │ (Any Origin) │
└────┬────┘                └──────┬───────┘              └──────┬───────┘
     │                            │                             │
     │ POST /api/das-proxy        │                             │
     │ (same-origin request)      │                             │
     ├──────────────────────────→ │                             │
     │                            │                             │
     │                            │ POST https://amplitude.com  │
     │                            │ (server-to-server)          │
     │                            ├────────────────────────────→│
     │                            │                             │
     │                            │         Response            │
     │                            │←────────────────────────────┤
     │                            │                             │
     │   Response + CORS headers  │                             │
     │←───────────────────────────┤                             │
     │                            │                             │
```

**Benefits:**
1. ✅ **No CORS issues** - Browser sees same-origin request
2. ✅ **No ad blocker blocks** - Request goes to our domain first
3. ✅ **Works with any API** - Google Sheets, Amplitude, Statsig, etc.
4. ✅ **Secure** - Credentials never exposed to external domains in browser
5. ✅ **Production-ready** - Works in dev (Vite) and production (Vercel)

## Why We Need It for ALL External APIs

Even though Google Sheets worked without the proxy, we should use the proxy for consistency:

1. **Reliability**: APIs can change CORS policies
2. **Uniformity**: One code path for all external requests
3. **Security**: Better credential handling
4. **Debugging**: Centralized logging of all external requests
5. **Future-proofing**: Works with any API, regardless of CORS support

## Configuration

The proxy is **enabled by default** in `BrowserHttpExecutor`:

```typescript
constructor(private readonly options: BrowserHttpExecutorOptions = {}) {
  // Use proxy by default in browser environment
  this.useProxy = options.useProxy ?? true;
}
```

To disable (e.g., for testing):
```typescript
const executor = new BrowserHttpExecutor({ useProxy: false });
```

But you should **never disable it in production** - many APIs simply won't work without it.

