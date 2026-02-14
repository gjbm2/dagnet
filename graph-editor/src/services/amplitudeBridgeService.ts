/**
 * amplitudeBridgeService
 *
 * Client for the DagNet Amplitude Bridge Chrome extension.
 * Handles detection, version checking, and draft creation via the extension.
 *
 * The extension acts as a "cookie fence-jumper" — it injects code into
 * an amplitude.com tab to make API calls with the user's existing session,
 * returning a draft funnel URL to DagNet.
 */

// Minimal type declarations for Chrome extension messaging API.
// We only declare the subset used here to avoid pulling in the full
// @types/chrome dependency (which is large and only needed at type-check time).
declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined;
    function sendMessage(
      extensionId: string,
      message: Record<string, unknown>,
      callback: (response: any) => void,
    ): void;
  }
}

// Extension ID — deterministic, derived from the key in manifest.json.
// This ID is stable across all installations.
const EXTENSION_ID = 'ncikgkoelfgkedmcigcfngbeoiecdbba';

// Current extension version that DagNet expects.
// Update this when shipping a new extension version.
const EXPECTED_VERSION = '0.1.2';

// Download URL for the extension zip (served from DagNet's public folder).
// The version in the filename allows cache-busting.
const DOWNLOAD_URL = '/downloads/dagnet-amplitude-bridge-0.1.2.zip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeStatus {
  installed: boolean;
  version: string | null;
  updateAvailable: boolean;
  expectedVersion: string;
  downloadUrl: string;
}

export interface DraftResult {
  success: true;
  editId: string;
  draftUrl: string;
}

export interface DraftError {
  success: false;
  reason: 'not_installed' | 'not_authenticated' | 'api_error' | 'network_error' | 'update_required' | string;
  message: string;
}

export type CreateDraftResult = DraftResult | DraftError;

export interface AmplitudeChartDefinition {
  app: string;
  type: 'funnels';
  vis: 'bar';
  version: number;
  name: string | null;
  params: {
    mode: 'ordered' | 'unordered' | 'sequential';
    range?: string;
    start?: number;
    end?: number;
    interval: number;
    metric: 'CONVERSION';
    conversionSeconds: number;
    newOrActive: 'active';
    nthTimeLookbackWindow: number;
    isFunnelPreciseComputationEnabled: boolean;
    countGroup: { name: string; is_computed: boolean };
    events: Array<{
      event_type: string;
      filters: any[];
      group_by: any[];
    }>;
    segments: Array<{
      name: string;
      label: string;
      conditions: any[];
    }>;
    groupBy: any[];
    constantProps: any[];
    excludedEvents: any[];
  };
}

// ---------------------------------------------------------------------------
// Extension communication
// ---------------------------------------------------------------------------

/**
 * Check whether the chrome.runtime messaging API is available.
 * Returns false in non-Chrome browsers or non-HTTPS contexts.
 */
function canMessage(): boolean {
  return typeof chrome !== 'undefined' &&
    typeof chrome.runtime !== 'undefined' &&
    typeof chrome.runtime.sendMessage === 'function';
}

/**
 * Send a message to the extension and wait for a response.
 * Rejects if the extension is not installed or doesn't respond.
 */
function sendToExtension(message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!canMessage()) {
      reject(new Error('Chrome extension messaging not available.'));
      return;
    }
    try {
      chrome.runtime.sendMessage(EXTENSION_ID, message, (response: any) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Extension not reachable.'));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the extension status: installed, version, update needed.
 */
export async function checkBridgeStatus(): Promise<BridgeStatus> {
  const base = {
    expectedVersion: EXPECTED_VERSION,
    downloadUrl: DOWNLOAD_URL,
  };

  if (!canMessage()) {
    return { ...base, installed: false, version: null, updateAvailable: false };
  }

  try {
    const resp = await sendToExtension({ action: 'ping' });
    if (resp?.ok) {
      const version = resp.version || null;
      const updateAvailable = version !== EXPECTED_VERSION;
      return { ...base, installed: true, version, updateAvailable };
    }
    return { ...base, installed: false, version: null, updateAvailable: false };
  } catch {
    return { ...base, installed: false, version: null, updateAvailable: false };
  }
}

/**
 * Poll for extension installation. Resolves when the extension is detected
 * or rejects after the timeout.
 *
 * @param intervalMs  Polling interval (default 5000ms)
 * @param timeoutMs   Give up after this long (default 5 minutes)
 */
export function waitForExtension(
  intervalMs = 5000,
  timeoutMs = 5 * 60 * 1000,
): { promise: Promise<BridgeStatus>; cancel: () => void } {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => { cancelled = true; if (timer) clearTimeout(timer); };

  const promise = new Promise<BridgeStatus>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const poll = async () => {
      if (cancelled) { reject(new Error('Cancelled')); return; }
      if (Date.now() > deadline) { reject(new Error('Timeout waiting for extension.')); return; }

      const status = await checkBridgeStatus();
      if (status.installed) {
        resolve(status);
      } else {
        timer = setTimeout(poll, intervalMs);
      }
    };

    poll();
  });

  return { promise, cancel };
}

/**
 * Create a funnel chart draft in Amplitude via the extension.
 *
 * @param definition  The full Amplitude chart definition (params.events, params.segments, etc.)
 * @param orgId       Amplitude org ID (from connection config defaults.org_id)
 * @param orgSlug     Amplitude org URL slug (from connection config defaults.org_slug)
 */
export async function createAmplitudeDraft(
  definition: AmplitudeChartDefinition,
  orgId: string,
  orgSlug: string,
): Promise<CreateDraftResult> {
  // Check extension status first
  const status = await checkBridgeStatus();

  if (!status.installed) {
    return { success: false, reason: 'not_installed', message: 'DagNet Amplitude Bridge extension is not installed.' };
  }

  if (status.updateAvailable) {
    // Warn but don't block — version mismatch is non-fatal for now
    console.warn(`[amplitudeBridge] Extension v${status.version} vs expected v${EXPECTED_VERSION}. Proceeding anyway.`);
  }

  try {
    const resp = await sendToExtension({
      action: 'createDraft',
      definition,
      orgId,
      orgSlug,
    });
    return resp;
  } catch (err) {
    return {
      success: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get the extension download URL for the current version.
 */
export function getExtensionDownloadUrl(): string {
  return DOWNLOAD_URL;
}

/**
 * Get the expected extension version.
 */
export function getExpectedVersion(): string {
  return EXPECTED_VERSION;
}

/**
 * Get the fixed extension ID (for troubleshooting).
 */
export function getExtensionId(): string {
  return EXTENSION_ID;
}
