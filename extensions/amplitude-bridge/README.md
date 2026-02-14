# Amplitude Bridge — Browser Extension

A minimal Chrome extension that enables DagNet to create funnel chart drafts in Amplitude using your existing browser session.

## What it does

When you click "Amplitude" in DagNet's Analytics panel, this extension receives the chart definition and creates it in Amplitude on your behalf. It uses your existing Amplitude login session — no additional credentials are needed.

The extension only activates when DagNet explicitly sends a message. It has no background activity, no tracking, and no permissions beyond the `app.amplitude.com` domain.

## Installation

1. Open `chrome://extensions` in Chrome (or equivalent in Edge, Brave, Arc).
2. Enable **Developer mode** (toggle in the top right).
3. Click **Load unpacked**.
4. Select this folder (`extensions/amplitude-bridge/`).
5. Note the extension ID that appears — DagNet will ask for it on first use.

## Compatibility

Chrome, Edge, Brave, Arc, and other Chromium-based browsers. Not supported in Firefox or Safari.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker — handles messages from DagNet, injects chart creation code into the Amplitude tab |
| `test.html` | Manual test page (open in browser to test the extension independently) |

## How it works

1. DagNet sends an `externally_connectable` message to the extension with `{ action: 'createDraft', definition, orgId, orgSlug }`.
2. The extension finds (or opens) an `app.amplitude.com` tab.
3. It injects a content script into that tab which makes same-origin POST requests to Amplitude's internal API (`/d/config/{orgId}/data/edit` + `CreateOrUpdateChartDraft` GraphQL mutation).
4. The draft URL is returned to DagNet, which opens it in a new tab.

## Security

- **Minimal permissions**: only `app.amplitude.com` origin access.
- **No data collection**: the extension does not read, store, or transmit any data beyond the chart definition DagNet sends it.
- **Source-auditable**: the entire extension is ~100 lines of JavaScript in this folder.
- **Externally connectable**: only pages on `localhost` or DagNet's deployed domain can send messages to the extension.
