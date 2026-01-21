/**
 * URL Settings Utilities
 * 
 * Handles parsing and merging settings from URL parameters
 * Security: Never accepts credentials via URL - only repository configs
 */

export interface URLRepositoryConfig {
  name: string;
  repoOwner: string;
  repoName: string;
  branch?: string;
  graphsPath?: string;
  paramsPath?: string;
  contextsPath?: string;
  casesPath?: string;
  nodesPath?: string;
  eventsPath?: string;
  isDefault?: boolean;
  // Note: auth and permissions are NOT allowed in URL for security
}

export interface URLSettings {
  repositories?: URLRepositoryConfig[];
  development?: {
    devMode?: boolean;
    debugGitOperations?: boolean;
  };
}

/**
 * Read a boolean flag from URL search params.
 *
 * Supported truthy values (case-insensitive): "", "1", "true", "yes", "on"
 * Supported falsy values (case-insensitive): "0", "false", "no", "off"
 *
 * Examples:
 * - ?flag            -> true
 * - ?flag=1          -> true
 * - ?flag=true       -> true
 * - ?flag=0          -> false
 * - (absent)         -> false
 */
export function getURLBooleanParam(searchParams: URLSearchParams, name: string): boolean {
  if (!searchParams.has(name)) return false;
  const raw = searchParams.get(name);
  if (raw === null) return true; // present without a value
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  // If the param is present but unrecognised, treat as true (safe for flags)
  return true;
}

/**
 * Parse settings from URL parameters
 * 
 * @param searchParams - URLSearchParams object from window.location
 * @returns Parsed settings object or null if invalid
 */
export function parseURLSettings(searchParams: URLSearchParams): URLSettings | null {
  try {
    const settingsParam = searchParams.get('settings');
    if (!settingsParam) {
      return null;
    }

    // Decode and parse JSON
    const decoded = decodeURIComponent(settingsParam);
    const parsed = JSON.parse(decoded);

    // Validate structure
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('URL settings: Invalid JSON structure');
      return null;
    }

    // Validate repositories array if present
    if (parsed.repositories) {
      if (!Array.isArray(parsed.repositories)) {
        console.warn('URL settings: repositories must be an array');
        return null;
      }

      // Validate each repository config
      for (const repo of parsed.repositories) {
        if (!repo.name || !repo.repoOwner || !repo.repoName) {
          console.warn('URL settings: Repository missing required fields');
          return null;
        }

        // Security check: ensure no auth/permissions in URL
        if (repo.auth || repo.permissions) {
          console.warn('URL settings: auth/permissions not allowed in URL for security');
          return null;
        }
      }
    }

    return parsed as URLSettings;
  } catch (error) {
    console.warn('URL settings: Failed to parse settings parameter:', error);
    return null;
  }
}

/**
 * Merge URL settings with existing settings
 * URL settings take precedence over existing settings
 * 
 * @param existingSettings - Current settings from IndexedDB
 * @param urlSettings - Settings from URL parameters
 * @returns Merged settings object
 */
export function mergeURLSettings(existingSettings: any, urlSettings: URLSettings): any {
  if (!urlSettings) {
    return existingSettings;
  }

  const merged = { ...existingSettings };

  // Merge repositories
  if (urlSettings.repositories) {
    // If URL has repositories, use them but preserve auth/permissions from existing
    merged.repositories = urlSettings.repositories.map(urlRepo => {
      // Find matching existing repo by name
      const existingRepo = existingSettings.repositories?.find((r: any) => r.name === urlRepo.name);
      
      return {
        ...urlRepo,
        // Preserve auth and permissions from existing settings
        auth: existingRepo?.auth || { type: 'none' },
        permissions: existingRepo?.permissions || {
          canRead: true,
          canWrite: false,
          canCommit: false
        }
      };
    });
  }

  // Merge development settings
  if (urlSettings.development) {
    merged.development = {
      ...existingSettings.development,
      ...urlSettings.development
    };
  }

  return merged;
}

/**
 * Generate URL with settings parameter
 * 
 * @param settings - Settings to encode in URL
 * @param baseUrl - Base URL (defaults to current location)
 * @returns URL string with settings parameter
 */
export function generateSettingsURL(settings: URLSettings, baseUrl?: string): string {
  try {
    const url = new URL(baseUrl || window.location.href);
    
    // Remove existing settings parameter
    url.searchParams.delete('settings');
    
    // Add new settings parameter
    const encoded = encodeURIComponent(JSON.stringify(settings));
    url.searchParams.set('settings', encoded);
    
    return url.toString();
  } catch (error) {
    console.error('Failed to generate settings URL:', error);
    return baseUrl || window.location.href;
  }
}

/**
 * Check if current URL has settings parameter
 */
export function hasURLSettings(): boolean {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.has('settings');
}

/**
 * Get clean URL without settings parameter
 */
export function getCleanURL(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('settings');
  return url.toString();
}
