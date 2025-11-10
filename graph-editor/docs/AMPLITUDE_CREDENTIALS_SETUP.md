# Setting Up Amplitude Credentials

## Quick Fix

Your proxy is **working perfectly**! The 401 error means Amplitude is receiving your request but rejecting it due to invalid/missing credentials.

## Step 1: Get Your Amplitude API Keys

1. Log into your Amplitude account
2. Go to **Settings** → **Projects** → Select your project
3. Click on **API Keys** tab
4. You need two values:
   - **API Key** (acts as username)
   - **Secret Key** (acts as password)

## Step 2: Add Credentials to DagNet

### Option A: Via UI (Recommended)

1. In DagNet, go to **File** → **Credentials**
2. Find the `amplitude` section (or add it if missing)
3. Add your keys:

```yaml
amplitude:
  - name: prod
    api_key: "YOUR_API_KEY_HERE"
    secret_key: "YOUR_SECRET_KEY_HERE"
```

4. Save the file
5. The app will automatically generate `basic_auth_b64` for you

### Option B: Manual (Advanced)

If you prefer to pre-encode your credentials:

```bash
# In terminal:
echo -n "YOUR_API_KEY:YOUR_SECRET_KEY" | base64
```

Then add to credentials:

```yaml
amplitude:
  - name: prod
    basic_auth_b64: "BASE64_STRING_FROM_ABOVE"
```

## Step 3: Test Again

Click the ⚡ icon → "Get from Source (direct)" again.

You should now see:
- ✅ `POST http://localhost:5173/api/das-proxy 200 (OK)`
- ✅ Data successfully fetched from Amplitude
- ✅ Graph updated with conversion rates

## How It Works

The DASRunner automatically handles Amplitude's authentication:

```typescript
// From DASRunner.ts:84-92
if (connection.provider === 'amplitude' && 
    credentials.api_key && 
    credentials.secret_key && 
    !credentials.basic_auth_b64) {
  
  // Auto-generate Basic Auth header
  const basicAuthString = `${credentials.api_key}:${credentials.secret_key}`;
  credentials.basic_auth_b64 = btoa(basicAuthString);
}
```

Then the connection template uses it:

```yaml
# From connections.yaml
headers:
  Authorization: "Basic {{credentials.basic_auth_b64}}"
```

## Troubleshooting

### Still Getting 401?

**Check your API keys:**
1. Verify you copied them correctly (no extra spaces)
2. Ensure you're using the **Dashboard REST API** keys, not the **HTTP API** keys
3. Check that your Amplitude project has the Dashboard REST API enabled

**Check your connection:**
```yaml
# In your parameter file or edge, ensure:
connection: amplitude-prod
credsRef: amplitude  # Must match your credentials file
```

### Getting 403 Forbidden?

- Your API keys are valid but don't have permission to access the funnel endpoint
- Check your Amplitude plan includes Dashboard REST API access
- Verify your project settings in Amplitude

### Getting 429 Rate Limited?

- You're making too many requests
- Amplitude has rate limits per API key
- Wait a few minutes and try again

## Testing Without Real Credentials

For testing the proxy itself (without hitting Amplitude), you can use httpbin:

```javascript
// In browser console:
fetch('/api/das-proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://httpbin.org/anything',
    method: 'POST',
    headers: { 'X-Test': 'true' },
    body: JSON.stringify({ test: 'data' })
  })
}).then(r => r.json()).then(console.log);

// Should return 200 with your request echoed back
```

## Success Indicators

When credentials are working correctly, you'll see:

```
✅ [DASRunner:load_credentials] Credentials loaded {hasCredentials: true}
✅ [DASRunner:build_request] HTTP request built {url: '...', method: 'POST'}
✅ [BrowserHttpExecutor] Proxying POST request to: https://amplitude.com/api/2/funnels
✅ POST http://localhost:5173/api/das-proxy 200 (OK)
✅ [DASRunner:extract_data] Extracted 2 variables {from_count: 1234, to_count: 567}
✅ [DASRunner:transform] Calculated p_mean: 0.459...
```

Then your graph will update with the fetched data! 🎉

