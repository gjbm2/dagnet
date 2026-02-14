/**
 * DagNet Amplitude Bridge — Background Service Worker
 *
 * Receives messages from DagNet web app and creates funnel chart drafts
 * in Amplitude using the user's existing browser session.
 *
 * The API calls must originate from an amplitude.com page context
 * (not the extension's service worker) because Amplitude validates
 * the Origin header for CSRF protection.
 *
 * Strategy: inject a MAIN-world script into an amplitude.com tab
 * that makes the API calls with the page's origin and cookies.
 */

const VERSION = '0.1.2';

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});

// Also listen for internal messages from injected content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?._bridgeResponse) {
    // This is handled via the scripting.executeScript return value, not here
    return;
  }
});

async function handleMessage(message, _sender) {
  if (!message || !message.action) {
    return { success: false, reason: 'invalid_message', message: 'No action specified.' };
  }

  switch (message.action) {
    case 'ping':
      return { ok: true, version: VERSION };

    case 'createDraft':
      return await createDraft(message);

    default:
      return { success: false, reason: 'unknown_action', message: `Unknown action: ${message.action}` };
  }
}

/**
 * Find an existing amplitude.com tab, or create one.
 * Returns the tab ID.
 */
async function getAmplitudeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://app.amplitude.com/*' });
  if (tabs.length > 0) {
    return tabs[0].id;
  }
  // No amplitude tab open — create one (minimised/background)
  const tab = await chrome.tabs.create({
    url: 'https://app.amplitude.com',
    active: false,
  });
  // Wait for it to load
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab.id;
}

/**
 * Create an Amplitude funnel chart draft by injecting code into
 * an amplitude.com tab (ensuring correct Origin header and cookies).
 */
async function createDraft({ definition, orgId, orgSlug }) {
  if (!definition || !orgId) {
    return { success: false, reason: 'invalid_params', message: 'definition and orgId are required.' };
  }

  try {
    const tabId = await getAmplitudeTab();

    // Inject and execute the draft creation in the amplitude.com page context
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',  // Run in the page's JS context (same origin, cookies included)
      func: createDraftInPage,
      args: [definition, orgId, orgSlug],
    });

    // executeScript returns an array of results (one per frame)
    const result = results?.[0]?.result;
    if (!result) {
      return { success: false, reason: 'injection_failed', message: 'Script injection returned no result.' };
    }
    return result;

  } catch (err) {
    return { success: false, reason: 'extension_error', message: err.message || String(err) };
  }
}

/**
 * This function is serialised and injected into the amplitude.com page.
 * It runs in the MAIN world — same origin, same cookies, correct Origin header.
 * It must be self-contained (no closures over extension variables).
 */
async function createDraftInPage(definition, orgId, orgSlug) {
  try {
    // Step 1: Store chart definition
    const editResponse = await fetch(`/d/config/${orgId}/data/edit`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-org': orgId,
      },
      body: JSON.stringify({ chart_id: null, definition }),
    });

    if (editResponse.status === 401) {
      return { success: false, reason: 'not_authenticated', message: 'Not logged into Amplitude. Please log in and try again.' };
    }
    if (!editResponse.ok) {
      const text = await editResponse.text();
      return { success: false, reason: 'api_error', message: `Edit returned ${editResponse.status}: ${text.substring(0, 200)}` };
    }

    const editData = await editResponse.json();
    const editId = editData.editId;
    if (!editId) {
      return { success: false, reason: 'api_error', message: 'No editId in response.' };
    }

    // Step 2: Register the draft
    const gqlResponse = await fetch(`/t/graphql/org/${orgId}?q=CreateOrUpdateChartDraft`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-org': orgId,
      },
      body: JSON.stringify({
        operationName: 'CreateOrUpdateChartDraft',
        variables: { editId, prevEditId: null },
        query: `mutation CreateOrUpdateChartDraft($chartId: String, $prevEditId: String, $editId: ID!) {
          createOrUpdateChartDraft(chartId: $chartId, prevEditId: $prevEditId, editId: $editId) {
            editId chartId __typename
          }
        }`,
      }),
    });

    if (!gqlResponse.ok) {
      const text = await gqlResponse.text();
      return { success: false, reason: 'api_error', message: `GraphQL returned ${gqlResponse.status}: ${text.substring(0, 200)}` };
    }

    const gqlData = await gqlResponse.json();
    if (gqlData.errors) {
      return { success: false, reason: 'api_error', message: JSON.stringify(gqlData.errors).substring(0, 200) };
    }

    const draftUrl = `https://app.amplitude.com/analytics/${orgSlug}/chart/new/${editId}`;
    return { success: true, editId, draftUrl };

  } catch (err) {
    return { success: false, reason: 'network_error', message: err.message || String(err) };
  }
}
